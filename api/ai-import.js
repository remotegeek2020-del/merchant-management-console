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
            Act as a precise inventory audit engine. Extract EVERY hardware serial number from the attached PDF.
            
            VENDOR RECOGNITION:
            1. VALOR PAYTECH: Serials are long comma-separated lists (e.g., 1812519...) inside "Description" or "Memo" fields. Extract EVERY single number.
            2. DEJAVOO SYSTEMS: Serials are in a dedicated "Serial Numbers" table. Match them to the Part Numbers (KOZ-P1, Koz-P3, etc.) using the line indices (1, 2, 3...) provided in the tables.
            
            MAPPING RULES:
            - VL-550 / VL550 -> "Valor VL550"
            - VP800 -> "Valor VP800"
            - KOZ-P1 / P1 -> "Dejavoo P1"
            - Koz-P3 / P3 -> "Dejavoo P3"
            - Koz-P5 / P5 -> "Dejavoo P5"
            - KOZ-P17 / P17 -> "Dejavoo P17"
            
            CLEANING:
            - Remove all dots, spaces, and commas from the serial number strings.
            - Ensure every serial number is a separate object in the result array.
            
            OUTPUT:
            Return ONLY a raw JSON array. No conversational text. No Markdown backticks.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- ROBUST JSON RECOVERY ---
        // Some models include Markdown backticks even when asked not to.
        // We find the first '[' and last ']' to isolate the raw array.
        const arrayStart = text.indexOf('[');
        const arrayEnd = text.lastIndexOf(']');

        if (arrayStart === -1 || arrayEnd === -1) {
            console.error("AI Response failed to include a JSON array:", text);
            return sendJsonError(422, "The AI could not identify a valid list of serial numbers in this file.");
        }

        let jsonString = text.substring(arrayStart, arrayEnd + 1);

        // Fix potential "trailing comma" fatigue errors from the AI
        jsonString = jsonString.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');

        try {
            const data = JSON.parse(jsonString);
            const finalData = Array.isArray(data) ? data : [];
            
            if (finalData.length === 0) {
                return sendJsonError(422, "Document scanned successfully, but no equipment serials were found.");
            }

            return res.status(200).json({ success: true, data: finalData });
        } catch (parseErr) {
            console.error("JSON Parse Error. Cleaned text segment:", jsonString);
            return sendJsonError(500, "The data was found, but it was too large or complex to process. Try uploading pages separately.");
        }

    } catch (err) {
        console.error("Critical AI Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
