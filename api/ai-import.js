import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

export default async function handler(req, res) {
    const sendJsonError = (status, message, details = null) => {
        return res.status(status).json({ success: false, message, details });
    };

    if (req.method !== 'POST') return sendJsonError(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY) return sendJsonError(500, 'API Key Missing');

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return sendJsonError(400, 'No file data received.');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Using gemini-1.5-flash with a Strict JSON Schema.
        // This is the fastest and most reliable way to get structured data back.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
                responseSchema: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    serial_number: { type: "string" },
                                    terminal_type: { type: "string" }
                                },
                                required: ["serial_number", "terminal_type"]
                            }
                        }
                    },
                    required: ["items"]
                }
            }
        });

        const prompt = `
            Extract ALL hardware serial numbers from the attached invoice.
            
            - VALOR units: Look for 12-digit numbers starting with 18125 or X5C8.
            - DEJAVOO units: Look for serials starting with P125, P325, P524, or P17B.
            
            Match them to these models: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- EMERGENCY REPAIR FOR TRUNCATED JSON ---
        // If the AI was cut off by Vercel's 10s limit, we try to close the JSON manually.
        if (text && !text.endsWith('}')) {
            const lastBrace = text.lastIndexOf('}');
            if (lastBrace !== -1) {
                text = text.substring(0, lastBrace + 1);
                // Ensure it's a valid object end
                if (!text.endsWith(']}')) text += ']}';
            }
        }

        let items = [];
        try {
            const parsed = JSON.parse(text);
            items = parsed.items || [];
        } catch (e) {
            // Fallback: If JSON is totally broken, try a quick regex scrape of the text we DID get
            const snRegex = /\b(P125|P325|P524|P17B|18125|X5C8)[A-Z0-9]{7,12}\b/g;
            const matches = text.match(snRegex) || [];
            items = matches.map(sn => ({
                serial_number: sn,
                terminal_type: text.toLowerCase().includes('valor') ? "Valor" : "Dejavoo"
            }));
        }

        if (items.length === 0) {
            return sendJsonError(422, "No serial numbers were found. Ensure the PDF is a digital file (not a scan of a scan).");
        }

        // Final deduplication
        const seen = new Set();
        const cleanedItems = items.filter(item => {
            const sn = String(item.serial_number || "").toUpperCase().replace(/\s/g, "");
            if (!sn || seen.has(sn)) return false;
            seen.add(sn);
            return true;
        });

        return res.status(200).json({ success: true, data: cleanedItems });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
