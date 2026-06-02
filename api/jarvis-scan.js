import { GoogleGenerativeAI } from "@google/generative-ai";
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

const SCAN_INSTRUCTIONS = `You are a sensitive financial data detector for a merchant management system. Your ONLY job is to determine whether the provided content contains genuinely sensitive financial or identity data.

WHAT TO FLAG (only if clearly present):
- Bank account numbers or routing numbers
- EIN / TIN / SSN / Tax ID numbers
- Credit or debit card numbers (full PAN)
- Bank login credentials or passwords
- Social Security Numbers
- Wire transfer details with full account/routing info

WHAT NOT TO FLAG:
- Business names containing "bank", "capital", "financial"
- General payment volumes or transaction totals
- Processing fees, rates, percentages
- Merchant portal reference numbers

CALIBRATION: Be conservative — only flag at 75%+ confidence. Err toward NOT flagging.

Respond ONLY with valid JSON — no markdown, no explanation:
{"flagged":true,"confidence":"high","findings":["Routing number detected"]}
or
{"flagged":false,"confidence":"low","findings":[]}`;

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (!process.env.GEMINI_API_KEY) {
        return res.status(200).json({ flagged: false, error: 'GEMINI_API_KEY not configured' });
    }

    const { content, content_type, content_base64, mime_type, file_name } = req.body;

    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        let rawText;

        if (content_base64 && mime_type) {
            // Binary file (PDF / image): use multimodal — embed instructions in user turn
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const result = await model.generateContent([
                { text: SCAN_INSTRUCTIONS + `\n\nScan the attached file named "${file_name || 'unknown'}" and return the JSON result.` },
                { inlineData: { mimeType: mime_type, data: content_base64 } }
            ]);
            rawText = result.response.text().trim();

        } else if (content && typeof content === 'string') {
            // Text / filename: use plain text path with system instruction
            const model = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction: SCAN_INSTRUCTIONS
            });
            const truncated = content.slice(0, 4000);
            const result = await model.generateContent(
                `Content type: ${content_type || 'text'}\n\nContent to scan:\n"""\n${truncated}\n"""`
            );
            rawText = result.response.text().trim();

        } else {
            return res.status(400).json({ flagged: false, error: 'No content provided' });
        }

        // Strip markdown code fences if Gemini wraps the response
        const jsonStr = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const parsed = JSON.parse(jsonStr);

        return res.status(200).json({
            flagged: !!parsed.flagged,
            confidence: parsed.confidence || 'low',
            findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 5) : []
        });

    } catch (err) {
        console.error('[Jarvis Scan Error]', err.message, err.stack?.split('\n')[1] || '');
        return res.status(200).json({ flagged: false, error: 'Scan unavailable: ' + err.message });
    }
}
