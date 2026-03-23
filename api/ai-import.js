import { GoogleGenerativeAI } from "@google/generative-ai";

// Vercel config to increase body size limit
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
        
        // We are using a higher-level prompt and manual parsing for maximum reliability
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: { 
                temperature: 0.1 
            }
        });

        const prompt = `
            You are a precise data extraction tool.
            TASK: Extract EVERY hardware serial number from the attached invoice PDF.
            
            MAPPING RULES:
            - If item is VL-550 or VP800 -> terminal_type: "Valor VL550" or "Valor VP800"
            - If item is KOZ-P1, KOZ-P3, KOZ-P5, or KOZ-P17 -> terminal_type: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", or "Dejavoo P17"
            
            EXTRACTION LOGIC:
            - VALOR: Serial numbers are in long comma-separated blocks (e.g., 1812519...). Extract every single one.
            - DEJAVOO: Serial numbers are in a dedicated table, often matching a Line/Part No. index (1, 2, 3...).
            
            OUTPUT REQUIREMENT:
            Return ONLY a JSON array of objects. Do not include markdown code blocks, do not include intro text.
            FORMAT: [{"serial_number": "...", "terminal_type": "..."}]
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- JSON HEALING LOGIC ---
        // 1. Remove Markdown code blocks if present
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        
        // 2. Locate the actual array [ ... ]
        const startBracket = text.indexOf('[');
        const endBracket = text.lastIndexOf(']');
        
        if (startBracket === -1 || endBracket === -1) {
            console.error("No JSON array found in AI response:", text);
            return sendJsonError(422, "The AI couldn't find a valid list of serial numbers in this document.");
        }

        const jsonString = text.substring(startBracket, endBracket + 1);

        try {
            const data = JSON.parse(jsonString);
            const finalData = Array.isArray(data) ? data : [];
            
            if (finalData.length === 0) {
                return sendJsonError(422, "No serial numbers were extracted. Please check the PDF quality.");
            }

            return res.status(200).json({ success: true, data: finalData });
        } catch (parseErr) {
            console.error("JSON Parse Error. Raw string segment:", jsonString);
            return sendJsonError(500, "The invoice format was recognized, but the list was too long or complex for the server to process in one go. Try a smaller file.");
        }

    } catch (err) {
        console.error("AI Error:", err);
        return sendJsonError(500, `AI Error: ${err.message}`);
    }
}
