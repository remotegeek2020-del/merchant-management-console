import { GoogleGenerativeAI } from "@google/generative-ai";
import { validateSession, sessionErrorResponse } from './_validate.js';

// Vercel body size limit is 4.5 MB — increase for base64-encoded file payloads
export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

const systemPrompt = `You are a sensitive financial data detector for a merchant management system. Your ONLY job is to determine whether the provided content contains genuinely sensitive financial or identity data that should not be stored in plain text notes or attached as unencrypted documents.

WHAT TO FLAG (only flag if clearly present):
- Bank account numbers (routing numbers, account numbers)
- EIN / TIN / SSN / Tax ID numbers
- Credit or debit card numbers (full PAN)
- Bank login credentials or passwords
- Wire transfer details with full account info
- Social Security Numbers

WHAT NOT TO FLAG (these are normal in a merchant context):
- Business names that contain words like "bank", "capital", "financial"
- General payment volume amounts or transaction totals
- Processing fees, rates, percentages
- Merchant IDs or portal reference numbers
- General descriptions of financial products or services

CALIBRATION: Be conservative. Only flag content where you are at least 75% confident that real sensitive data is present. A false positive wastes time; a false negative is a minor data risk. Err toward NOT flagging.

Respond ONLY with a JSON object in this exact format:
{"flagged": true/false, "confidence": "high"/"medium"/"low", "findings": ["finding 1", "finding 2"]}

Where findings is an empty array if not flagged, or a brief list of what was detected (e.g. "Routing number pattern detected", "EIN format detected"). Keep each finding under 60 characters.`;

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
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', systemInstruction: systemPrompt });

        let result;

        if (content_base64 && mime_type) {
            // Binary file path: send to Gemini as inline multimodal data
            const prompt = `Scan this file (named "${file_name || 'unknown'}") for sensitive financial or identity data.`;
            result = await model.generateContent({
                contents: [{
                    role: 'user',
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: mime_type, data: content_base64 } }
                    ]
                }]
            });
        } else if (content && typeof content === 'string') {
            // Text path: send as plain text
            const truncated = content.slice(0, 4000);
            result = await model.generateContent(
                `Content type: ${content_type || 'text'}\n\nContent to scan:\n"""\n${truncated}\n"""`
            );
        } else {
            return res.status(400).json({ flagged: false, error: 'No content provided' });
        }

        const raw = result.response.text().trim();
        const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(jsonStr);

        return res.status(200).json({
            flagged: !!parsed.flagged,
            confidence: parsed.confidence || 'low',
            findings: Array.isArray(parsed.findings) ? parsed.findings.slice(0, 5) : []
        });
    } catch (err) {
        console.error('[Jarvis Scan Error]', err.message);
        return res.status(200).json({ flagged: false, error: 'Scan unavailable' });
    }
}
