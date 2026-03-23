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
        
        // We use the absolute latest model.
        // We are REMOVING responseSchema to give the model room to finish long lists.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025",
            generationConfig: {
                temperature: 0, // Maximum determinism
                topP: 1,
                topK: 1
            }
        });

        const prompt = `
            Act as a precision hardware auditor. 
            Extract EVERY serial number from this PDF.
            
            VENDOR PATTERNS:
            1. VALOR: Look for "Serial Numbers:" followed by long comma-separated lists in the Memo/Description column. Extract EVERY string.
            2. DEJAVOO: Look for the 'Serial Numbers' table at the end. Match serials to items using line numbers (1:KOZ-P1, 2:Koz-P3, etc).
            
            MAPPING:
            - Normalize to: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            - Clean serials: Strip periods, spaces, and commas from the serial itself.
            
            OUTPUT:
            Return ONLY a raw JSON array. 
            [{"serial_number": "...", "terminal_type": "..."}]
            Capture EVERY SINGLE serial number. Do not stop until all are listed.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- JSON RECOVERY LOGIC ---
        // 1. Strip Markdown noise
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        
        // 2. Find the start and end of the actual list
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');

        if (start === -1 || end === -1) {
            console.error("AI did not return a list. Output:", text);
            return sendJsonError(422, "The AI could not find a list in this invoice.");
        }

        let jsonString = text.substring(start, end + 1);

        // 3. AUTO-REPAIR: If the list was cut off mid-way (likely for Dejavoo),
        // we close it manually at the last valid object.
        if (!jsonString.endsWith(']')) {
            const lastClosingBrace = jsonString.lastIndexOf('}');
            if (lastClosingBrace !== -1) {
                jsonString = jsonString.substring(0, lastClosingBrace + 1) + ']';
            }
        }

        try {
            const data = JSON.parse(jsonString);
            return res.status(200).json({ success: true, data: Array.isArray(data) ? data : [] });
        } catch (parseErr) {
            console.error("Parse Fail. Raw start:", jsonString.substring(0, 50));
            return sendJsonError(500, "The data was found, but the file is too large to process in one scan. Please split the PDF and try page by page.");
        }

    } catch (err) {
        console.error("AI Error:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
