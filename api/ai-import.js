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
    // Helper to always return JSON
    const sendJsonError = (status, message) => {
        return res.status(status).json({ success: false, message });
    };

    if (req.method !== 'POST') return sendJsonError(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY) return sendJsonError(500, 'API Key Missing');

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return sendJsonError(400, 'No file data received.');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Use a strict schema to force the output format
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
            Extract hardware serial numbers and model types from this invoice. 
            Clean serials by removing dots, spaces, or commas.

            MAPPING RULES:
            - Valor (VL-550, VP800) -> 'Valor VL550' or 'Valor VP800'
            - Dejavoo (KOZ-P1, Koz-P3, Koz-P5, KOZ-P17) -> 'Dejavoo P1', 'Dejavoo P3', 'Dejavoo P5', 'Dejavoo P17'
        `;

        // Process multimodal input
        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text();
        
        // Clean potential markdown or extra chars
        text = text.trim();
        if (text.startsWith("```")) {
            text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        }

        try {
            const data = JSON.parse(text);
            // The responseSchema should ensure it is an array, but we check anyway
            const finalData = Array.isArray(data) ? data : (data.items || data.data || []);
            
            if (finalData.length === 0) {
                return sendJsonError(422, "AI found the document but couldn't identify any serial numbers.");
            }

            return res.status(200).json({ success: true, data: finalData });
        } catch (e) {
            // Final Regex fallback
            const match = text.match(/\[\s*\{.*\}\s*\]/s);
            if (match) {
                return res.status(200).json({ success: true, data: JSON.parse(match[0]) });
            }
            throw new Error("The AI response could not be parsed as a list.");
        }

    } catch (err) {
        console.error("Critical AI Error:", err);
        if (err.message.includes("413") || err.message.toLowerCase().includes("large")) {
            return sendJsonError(413, "This PDF is too large for the current server limit. Try splitting it.");
        }
        return sendJsonError(500, `AI Error: ${err.message}`);
    }
}
