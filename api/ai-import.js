import { GoogleGenerativeAI } from "@google/generative-ai";

// Vercel config to allow large base64 uploads from multi-page PDFs
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
        
        // Use the absolute latest model optimized for document parsing
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025",
            generationConfig: {
                responseMimeType: "application/json",
                // Strict schema helps the model stay on track
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
            You are a specialized inventory auditor. Extract EVERY hardware serial number from this invoice PDF.
            
            VENDOR PATTERNS:
            - VALOR PAYTECH: Look for "Serial Numbers:" followed by comma-separated lists in the Memo or Description column.
            - DEJAVOO: Look for the dedicated "Serial Numbers" table. Match serials to the model using the "Line/Part No" index (e.g., 1=P1, 2=P3).
            
            MAPPING RULES:
            - VL-550 / VL550 -> "Valor VL550"
            - VP800 -> "Valor VP800"
            - KOZ-P1 / P1 -> "Dejavoo P1"
            - Koz-P3 / P3 -> "Dejavoo P3"
            - Koz-P5 / P5 -> "Dejavoo P5"
            - KOZ-P17 / P17 -> "Dejavoo P17"
            
            IMPORTANT:
            - Capture EVERY single serial number. 
            - Clean serials: remove any dots, commas, or spaces from the serial number itself.
            - Return ONLY the JSON array.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- ADVANCED JSON REPAIR ---
        // 1. Remove Markdown markers
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        
        // 2. Locate the array
        const arrayStart = text.indexOf('[');
        const arrayEnd = text.lastIndexOf(']');

        if (arrayStart === -1 || arrayEnd === -1) {
            console.error("AI Response was not a list:", text);
            return sendJsonError(422, "The AI could not find a serial number list in this document.");
        }

        let jsonString = text.substring(arrayStart, arrayEnd + 1);

        // 3. Fix common "AI Fatigue" syntax errors (like trailing commas before a closing bracket)
        jsonString = jsonString.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');

        try {
            const data = JSON.parse(jsonString);
            const finalData = Array.isArray(data) ? data : [];
            
            if (finalData.length === 0) {
                return sendJsonError(422, "Document recognized, but no serial numbers were found.");
            }

            return res.status(200).json({ success: true, data: finalData });
        } catch (parseErr) {
            console.error("Final JSON Parse Error:", jsonString);
            return sendJsonError(500, "The list was found but was too large to format. Try uploading the pages separately.");
        }

    } catch (err) {
        console.error("Critical AI Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
