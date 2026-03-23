import { GoogleGenerativeAI } from "@google/generative-ai";

// Vercel config to allow large base64 uploads
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
        
        // Use the absolute latest model with strict JSON schema
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025",
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            serial_number: { type: "string" },
                            terminal_type: { type: "string" }
                        },
                        required: ["serial_number", "terminal_type"]
                    }
                },
                temperature: 0.1 
            }
        });

        const prompt = `
            Act as a precise data extraction tool for payment hardware inventory.
            Your mission: Extract EVERY serial number from the provided PDF invoice.
            
            DIRECTIONS FOR VENDORS:
            1. VALOR PAYTECH: 
               - Models: VL-550, VP800.
               - Location: Look for "Serial Numbers:" followed by long comma-separated lists in the 'Memo' or 'Description' column.
               - Task: Extract EVERY 12-digit numeric or alphanumeric string in those lists.
            
            2. DEJAVOO SYSTEMS:
               - Models: KOZ-P1, Koz-P3, Koz-P5, KOZ-P17.
               - Location: Look for the separate "Serial Numbers" table.
               - Task: Match serials to Part Numbers using the line indices (e.g., "1:KOZ-P1" means all serials following that index are Dejavoo P1s).
            
            MAPPING RULES:
            - Normalize types to: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            - Clean serials: Strip ALL dots, spaces, or commas from the serial number itself.
            
            OUTPUT:
            Return ONLY a JSON array. Capturing EVERY single serial number is critical.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- EMERGENCY JSON HEALING ---
        // 1. Remove Markdown code blocks if present
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        
        // 2. Locate the array boundaries [ ... ]
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');

        if (start === -1 || end === -1) {
            console.error("AI did not return a list. Raw output:", text);
            return sendJsonError(422, "The AI could not find a serial number list in this document.");
        }

        let jsonString = text.substring(start, end + 1);

        // 3. Fix truncated JSON if the list was so long it cut off mid-item
        if (!jsonString.endsWith(']')) {
            const lastClosingBrace = jsonString.lastIndexOf('}');
            if (lastClosingBrace !== -1) {
                jsonString = jsonString.substring(0, lastClosingBrace + 1) + ']';
            }
        }

        try {
            const data = JSON.parse(jsonString);
            const finalData = Array.isArray(data) ? data : [];
            
            if (finalData.length === 0) {
                return sendJsonError(422, "Scanned document but found 0 serial numbers.");
            }

            return res.status(200).json({ success: true, data: finalData });
        } catch (parseErr) {
            console.error("JSON Parse Fail. Snippet:", jsonString.substring(0, 100));
            return sendJsonError(500, "The invoice contains too many units to process in a single scan. Please try uploading the pages separately.");
        }

    } catch (err) {
        console.error("AI Error:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
