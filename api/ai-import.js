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
        
        // Use the absolute latest model optimized for document parsing
        // We force application/json mode which is the most stable for large arrays
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025",
            generationConfig: {
                responseMimeType: "application/json",
                temperature: 0, 
                topP: 1,
                topK: 1
            }
        });

        const prompt = `
            Act as a precise hardware inventory auditor.
            TASK: Extract EVERY hardware serial number from this PDF.
            
            VENDOR PATTERNS:
            1. VALOR: Look for comma-separated lists of 12-digit strings (e.g., 18125...).
            2. DEJAVOO: Look for the 'Serial Numbers' table at the end. Match serials to Part Numbers (KOZ-P1, Koz-P3, etc).
            
            MAPPING:
            - Normalize types to: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            - Clean serials: Strip periods, spaces, and commas from the serial itself.
            
            OUTPUT:
            Return ONLY a JSON array of objects: [{"serial_number": "...", "terminal_type": "..."}]
            It is critical to capture EVERY SINGLE serial number found across all pages.
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
            console.error("No array found in raw output:", text);
            return sendJsonError(422, "The AI could not identify a valid list in this invoice. Try a smaller PDF.");
        }

        // 3. JSON HEALING: This is the critical fix for high-volume invoices
        let jsonString = text.substring(start);
        
        // If the array didn't close (common for 100+ serials), we force-close it
        if (!jsonString.includes(']')) {
            const lastClosingBrace = jsonString.lastIndexOf('}');
            if (lastClosingBrace !== -1) {
                jsonString = jsonString.substring(0, lastClosingBrace + 1) + ']';
            }
        } else {
            // If it did close, make sure we only take up to the closing bracket
            const finalEnd = jsonString.lastIndexOf(']');
            jsonString = jsonString.substring(0, finalEnd + 1);
        }

        try {
            const data = JSON.parse(jsonString);
            const finalData = Array.isArray(data) ? data : [];
            
            if (finalData.length === 0) {
                return sendJsonError(422, "Found the file, but no serial numbers were identified.");
            }

            return res.status(200).json({ success: true, data: finalData });
        } catch (parseErr) {
            console.error("Final Parse Failure. Snippet:", jsonString.substring(0, 100));
            return sendJsonError(500, "The invoice is too long for one scan. Please upload Page 1 and Page 2 separately.");
        }

    } catch (err) {
        console.error("Critical AI Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
