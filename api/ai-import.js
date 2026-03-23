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
    const sendJsonError = (status, message) => {
        return res.status(status).json({ success: false, message });
    };

    if (req.method !== 'POST') return sendJsonError(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY) return sendJsonError(500, 'API Key Missing');

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return sendJsonError(400, 'No file data received.');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Use the absolute latest model with a strict JSON schema requirement
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
            Extract every hardware serial number from this invoice. 
            Associate each serial with its model name.
            
            RULES:
            - Valor (VL550, VP800)
            - Dejavoo (P1, P3, P5, P17)
            - Clean serials: remove dots, commas, or spaces.
            - Ensure every single serial number is captured, especially from multi-page lists.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- FINAL SAFETY CLEANSE ---
        // If the AI somehow included markdown, we hunt for the brackets
        const arrayStart = text.indexOf('[');
        const arrayEnd = text.lastIndexOf(']');

        if (arrayStart === -1 || arrayEnd === -1) {
            return sendJsonError(422, "The AI could not locate a serial number list in this file.");
        }

        const jsonString = text.substring(arrayStart, arrayEnd + 1);

        try {
            const data = JSON.parse(jsonString);
            return res.status(200).json({ success: true, data: Array.isArray(data) ? data : [] });
        } catch (parseErr) {
            return sendJsonError(500, "Data found but formatting was too complex. Try a 1-page version.");
        }

    } catch (err) {
        console.error("Critical AI Exception:", err);
        return sendJsonError(500, `AI Error: ${err.message}`);
    }
}
