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
        
        // Use 1.5-flash for speed and higher stability on high-volume lists
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
            }
        });

        const prompt = `
            Act as a precise data extraction engine. Extract EVERY hardware serial number from the attached invoice.
            
            SPECIFIC VENDOR PATTERNS:
            1. VALOR PAYTECH: Look for "Serial Numbers:" followed by a long comma-separated list. Extract EVERY 12-digit string.
            2. DEJAVOO SYSTEMS: Match serials (P125..., P325..., P524..., P17B...) to the Part Numbers (KOZ-P1, Koz-P3, etc) using the line numbers (1, 2, 3...) provided in the tables.
            
            MAPPING RULES:
            - Normalize to: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            - Clean serials: remove dots, spaces, or commas.
            
            OUTPUT REQUIREMENT:
            Return a JSON object with a key "items" containing the array: {"items": [{"serial_number": "...", "terminal_type": "..."}]}
            If the list is very long, extract as many as possible before the response ends.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- EMERGENCY RECOVERY ENGINE ---
        
        let finalItems = [];

        // Strategy 1: Attempt standard JSON parse
        try {
            // Clean markdown or extra noise if AI ignored JSON mode
            let cleanJson = text.replace(/```json/g, "").replace(/```/g, "").trim();
            
            // "Heal" truncated JSON: If it ends with a comma or doesn't close, try to close it.
            if (!cleanJson.endsWith('}')) {
                const lastBrace = cleanJson.lastIndexOf('}');
                if (lastBrace !== -1) {
                    // Find if we are inside an array
                    const lastBracket = cleanJson.lastIndexOf(']');
                    if (lastBracket < lastBrace) {
                        cleanJson = cleanJson.substring(0, lastBrace + 1) + ']}';
                    } else {
                        cleanJson = cleanJson.substring(0, lastBrace + 1);
                    }
                }
            }

            const parsed = JSON.parse(cleanJson);
            finalItems = parsed.items || (Array.isArray(parsed) ? parsed : []);
        } catch (e) {
            console.warn("Standard JSON Parse failed, falling back to Regex Scrape...");
        }

        // Strategy 2: Regex Scrape (The "Unbreakable" fallback)
        // This looks for any pair of serial/type even if the JSON is totally broken
        if (finalItems.length === 0) {
            const regex = /\{\s*"serial_number"\s*:\s*"([^"]+)"\s*,\s*"terminal_type"\s*:\s*"([^"]+)"\s*\}/g;
            let match;
            while ((match = regex.exec(text)) !== null) {
                finalItems.push({
                    serial_number: match[1],
                    terminal_type: match[2]
                });
            }
        }

        // Strategy 3: Raw Serial Pattern Matching (The "Nuclear" fallback)
        if (finalItems.length === 0) {
            const serialRegex = /\b[A-Z0-9]{10,16}\b/g;
            const found = text.match(serialRegex) || [];
            let defaultType = text.toLowerCase().includes("valor") ? "Valor VL550" : "Dejavoo P1";
            finalItems = found.map(s => ({ serial_number: s, terminal_type: defaultType }));
        }

        if (finalItems.length === 0) {
            return sendJsonError(422, "No items found. Ensure the PDF has readable text.");
        }

        // Clean up data and remove duplicates or short strings
        const cleanedData = finalItems
            .map(item => ({
                serial_number: String(item.serial_number || "").replace(/[.,\s]/g, ""),
                terminal_type: item.terminal_type || "Terminal"
            }))
            .filter(item => item.serial_number.length > 5);

        return res.status(200).json({ success: true, data: cleanedData });

    } catch (err) {
        console.error("Critical System Error:", err);
        return sendJsonError(500, `Processing Failed: ${err.message}`);
    }
}
