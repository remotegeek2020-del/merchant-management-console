import { GoogleGenerativeAI } from "@google/generative-ai";

// Vercel config to increase body size limit
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb', // Attempt to increase limit, though Vercel has a hard 4.5MB cap on serverless
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

        // Initialize Gemini
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Use v1beta features for better PDF support if needed, 
        // but the standard SDK usually handles this.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: { 
                responseMimeType: "application/json",
                temperature: 0.1 
            }
        });

        const prompt = `
            Extract hardware serial numbers and model types from this invoice. 
            Return a JSON array of objects: [{"serial_number": "...", "terminal_type": "..."}]

            MAPPING RULES:
            - Valor (VL-550, VP800) -> 'Valor VL550' or 'Valor VP800'
            - Dejavoo (KOZ-P1, Koz-P3, Koz-P5, KOZ-P17) -> 'Dejavoo P1', 'Dejavoo P3', 'Dejavoo P5', 'Dejavoo P17'
            
            IMPORTANT:
            - Capture EVERY serial number listed.
            - Clean serials (remove dots/spaces).
            - Output ONLY the raw JSON array.
        `;

        // Process multimodal input
        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text();
        
        // Handle cases where AI might still wrap in markdown code blocks
        if (text.includes("```")) {
            text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        }

        // Final attempt to find JSON array if text has extra noise
        try {
            const data = JSON.parse(text);
            const finalData = Array.isArray(data) ? data : (data.items || data.data || []);
            return res.status(200).json({ success: true, data: finalData });
        } catch (e) {
            // Regex fallback to find the array [ ... ]
            const match = text.match(/\[\s*\{.*\}\s*\]/s);
            if (match) {
                return res.status(200).json({ success: true, data: JSON.parse(match[0]) });
            }
            throw new Error("AI output format invalid");
        }

    } catch (err) {
        console.error("Critical AI Error:", err);
        // If the error is "Payload Too Large", send a specific hint
        if (err.message.includes("413") || err.message.toLowerCase().includes("large")) {
            return sendJsonError(413, "File is too large for Vercel. Try a 1-page PDF.");
        }
        return sendJsonError(500, `AI Error: ${err.message}`);
    }
}
