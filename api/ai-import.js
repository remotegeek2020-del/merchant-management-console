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
        
        // Use the absolute latest model for maximum context and logic
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025"
        });

        const prompt = `
            Act as a precision inventory scanner. 
            Extract EVERY hardware serial number from this invoice.
            
            DIRECTIONS:
            1. Scan EVERY page. Items are often on page 1 and serials on page 2.
            2. For Valor (VL-550, VP800): Serials are in long comma-separated blocks in the Memo/Description column.
            3. For Dejavoo (KOZ-P1, Koz-P3, Koz-P5, KOZ-P17): Serials are in a table at the end. Match them to the items using the line numbers (1, 2, 3, etc).
            
            CLEANING:
            - Normalize to: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            - Clean serials: Strip all periods, spaces, and commas from the serial number.
            
            OUTPUT:
            Return ONLY a raw JSON array. No text, no markdown.
            Format: [{"serial_number": "...", "terminal_type": "..."}]
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- EMERGENCY JSON HEALING ---
        // 1. Remove Markdown code blocks
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        
        // 2. Find the start and end of the array
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');

        if (start === -1 || end === -1) {
            console.error("AI did not return a list. Raw output:", text);
            return sendJsonError(422, "The AI could not find a list in this invoice. Check if the PDF text is selectable.");
        }

        let jsonString = text.substring(start, end + 1);

        // 3. Fix truncated JSON (If the list is so long it cut off)
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
                return sendJsonError(422, "Found the document, but 0 serial numbers were extracted.");
            }

            return res.status(200).json({ success: true, data: finalData });
        } catch (parseErr) {
            console.error("JSON Parse Fail. Snippet:", jsonString.substring(0, 100));
            return sendJsonError(500, "The invoice is too long for one process. Try uploading Page 1 and Page 2 separately.");
        }

    } catch (err) {
        console.error("AI Error:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
