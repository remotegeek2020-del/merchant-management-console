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
        
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
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
            Act as a data extraction engine for hardware inventory.
            EXTRACT ALL SERIAL NUMBERS from ALL pages of the provided PDF.
            
            MAPPING DICTIONARY:
            - Valor (VL-550, VP800) -> "Valor VL550" or "Valor VP800".
            - Dejavoo (KOZ-P1, KOZ-P3, KOZ-P5, KOZ-P17) -> "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", or "Dejavoo P17".
            
            INSTRUCTIONS FOR MULTI-PAGE DOCUMENTS:
            1. Scrape the entire document. If item names are on page 1 and serials are on page 2, you MUST link them correctly.
            2. For VALOR: Serials are comma-separated blocks in the "Memo" column.
            3. For DEJAVOO: Serials are in a dedicated "Serial Numbers" table.
            
            Return ONLY a raw JSON array: [{"serial_number": "...", "terminal_type": "..."}]
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // Final cleaning of the string
        const startBracket = text.indexOf('[');
        const endBracket = text.lastIndexOf(']');
        if (startBracket !== -1 && endBracket !== -1) {
            text = text.substring(startBracket, endBracket + 1);
        }

        const data = JSON.parse(text);
        const finalData = Array.isArray(data) ? data : [];
        
        if (finalData.length === 0) {
            return sendJsonError(422, "AI could not find any serial numbers. Ensure the PDF contains a serial number table.");
        }

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("AI Error:", err);
        return sendJsonError(500, `AI Error: ${err.message}`);
    }
}
