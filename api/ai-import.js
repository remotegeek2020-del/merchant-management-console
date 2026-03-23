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
    const sendJsonError = (status, message) => {
        return res.status(status).json({ success: false, message });
    };

    if (req.method !== 'POST') return sendJsonError(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY) return sendJsonError(500, 'API Key Missing');

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return sendJsonError(400, 'No file data received.');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Use 1.5-flash for maximum speed and stability on free tier
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                maxOutputTokens: 8192, // Ensure we don't truncate the 170+ list
            }
        });

        // We use a PIPE-DELIMITED format. 
        // This is the most "fail-safe" format for high-volume text generation on free-tier.
        const prompt = `
            EXTRACT ALL SERIALS.
            FORMAT: SERIAL|MODEL_NAME
            
            DIRECTIONS:
            1. VALOR: Extract 12-digit numbers from comma-lists.
            2. DEJAVOO: Match serials (starts with P12, P32, P52, P17) to models (KOZ-P1, Koz-P3, Koz-P5, KOZ-P17) using table line numbers.
            
            MODEL NAMES TO USE:
            "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800"
            
            Example output:
            P1250920000034|Dejavoo P1
            181251934334|Valor VL550
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text().trim();
        
        // --- THE "PIPE" PARSER ---
        const lines = rawText.split('\n');
        const finalItems = [];

        for (let line of lines) {
            line = line.trim();
            if (!line || !line.includes('|')) continue;
            
            const [sn, type] = line.split('|').map(s => s.trim());
            
            if (sn && sn.length > 5) {
                finalItems.push({
                    serial_number: sn.replace(/[.,\s]/g, ""),
                    terminal_type: type || "Terminal"
                });
            }
        }

        // --- EMERGENCY REGEX SCRAPE ---
        // If the pipe format failed, we scan for any 10-15 digit alphanumeric blocks 
        // that start with known terminal prefixes.
        if (finalItems.length === 0) {
            const serialRegex = /\b(P12|P32|P52|P17|1812|X5C)[A-Z0-9]{8,13}\b/g;
            const matches = rawText.match(serialRegex) || [];
            
            let guessedType = rawText.toLowerCase().includes("valor") ? "Valor VL550" : "Dejavoo P1";
            
            matches.forEach(s => {
                finalItems.push({
                    serial_number: s,
                    terminal_type: guessedType
                });
            });
        }

        if (finalItems.length === 0) {
            return sendJsonError(422, "No serial numbers identified. Try a higher resolution PDF or split it into single pages.");
        }

        return res.status(200).json({ success: true, data: finalItems });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
