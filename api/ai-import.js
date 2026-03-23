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
        
        // Using the absolute latest model available for high-density document parsing
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025",
            generationConfig: {
                temperature: 0, // Maximum determinism
                topP: 1,
                topK: 1
            }
        });

        const prompt = `
            Act as a high-precision data extraction system for merchant hardware. 
            Your goal is to extract EVERY hardware serial number from the attached PDF.
            
            DIRECTIONS FOR DATA:
            1. VALOR: Serials are in comma-separated blocks inside "Memo" or "Description".
            2. DEJAVOO: Serials are in a separate table at the end. Match serials to Part Numbers (KOZ-P1, Koz-P3, etc) using the line numbers (1, 2, 3...).
            
            MAPPING RULES:
            - Normalize to: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            - Clean serials: Strip periods, spaces, and commas from the serial itself.
            
            OUTPUT REQUIREMENT:
            Return ONLY a raw JSON array. Do not include markdown. Do not include any intro text.
            Capture EVERY SINGLE serial number found.
            Format: [{"serial_number": "...", "terminal_type": "..."}]
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- THE "UNIVERSE" PARSER: EXTREMELY ROBUST ---
        
        // 1. Remove Markdown markers if AI ignored instructions
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        
        // 2. Find the bounds of the array
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');

        if (start === -1) {
            console.error("No array found. Raw output:", text);
            return sendJsonError(422, "The AI could not identify a valid list in this invoice.");
        }

        // If end is missing or before start, we have a truncation issue
        let jsonString = end > start ? text.substring(start, end + 1) : text.substring(start);

        // 3. JSON HEALING: If the response was truncated mid-item (likely for 100+ serials)
        if (!jsonString.endsWith(']')) {
            // Find the last completed object
            const lastClosingBrace = jsonString.lastIndexOf('}');
            if (lastClosingBrace !== -1) {
                jsonString = jsonString.substring(0, lastClosingBrace + 1) + ']';
            } else {
                // If not even one object finished, something is wrong
                return sendJsonError(500, "The invoice is too long for the AI to process in one pass. Try uploading page by page.");
            }
        }

        try {
            const data = JSON.parse(jsonString);
            const finalData = Array.isArray(data) ? data : [];
            
            if (finalData.length === 0) {
                return sendJsonError(422, "Found the file, but no serial numbers were identified.");
            }

            return res.status(200).json({ success: true, data: finalData });
        } catch (parseErr) {
            console.error("Parse Error. Fragment:", jsonString.substring(0, 100));
            return sendJsonError(500, "The data was extracted but was formatted incorrectly. Try splitting the PDF.");
        }

    } catch (err) {
        console.error("AI Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
