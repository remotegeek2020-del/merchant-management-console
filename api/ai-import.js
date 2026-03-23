import { GoogleGenerativeAI } from "@google/generative-ai";

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
        
        // Use gemini-1.5-flash which is the most stable for high-volume extraction.
        // We REMOVE responseMimeType: "application/json" because strict mode 
        // will throw an unrecoverable error if the response is truncated.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
            }
        });

        const prompt = `
            Act as a precise data extraction tool. Extract EVERY hardware serial number from the attached PDF.
            
            DIRECTIONS:
            1. VALOR: Extract 12-digit numbers starting with 18125 or alphanumeric starting with X5C8.
            2. DEJAVOO: Match serials starting with P125, P325, P524, or P17B to models P1, P3, P5, P17.
            
            OUTPUT REQUIREMENT:
            Return the data as a JSON array of objects. 
            Format: [{"sn": "SERIAL", "type": "MODEL"}]
            
            IMPORTANT: If there are many serials, just list them all. Do not include any intro text.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- THE "SURVIVAL" PARSER ---
        // 1. Clean markdown if present
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();

        // 2. Find the array start
        const startIdx = text.indexOf('[');
        if (startIdx === -1) {
            console.error("No JSON found. AI said:", text);
            return sendJsonError(422, "The AI couldn't find a list of serial numbers. Ensure the PDF is clear.");
        }

        let jsonString = text.substring(startIdx);

        // 3. SURGICAL HEALING: If the JSON is truncated (common on Free Tier)
        // We look for the last complete object "}" and force-close the array.
        if (!jsonString.endsWith(']')) {
            const lastClosingBrace = jsonString.lastIndexOf('}');
            if (lastClosingBrace !== -1) {
                jsonString = jsonString.substring(0, lastClosingBrace + 1) + ']';
            }
        }

        let finalItems = [];
        const seenSerials = new Set();

        try {
            const parsed = JSON.parse(jsonString);
            const rawArray = Array.isArray(parsed) ? parsed : (parsed.items || []);
            
            rawArray.forEach(item => {
                const sn = String(item.sn || item.serial_number || "").replace(/[.,\s]/g, "").toUpperCase();
                const type = item.type || item.terminal_type || "Terminal";
                if (sn.length >= 8 && !seenSerials.has(sn)) {
                    finalItems.push({ serial_number: sn, terminal_type: type });
                    seenSerials.add(sn);
                }
            });
        } catch (e) {
            console.warn("JSON Parse failed, trying Regex Harvester fallback...");
        }

        // --- LAYER 2: REGEX HARVESTER (Absolute Fallback) ---
        // This picks up serials directly from the text if the JSON is totally broken.
        if (finalItems.length === 0) {
            const patterns = [
                { regex: /\b(18125\d{7})\b/g, type: "Valor VL550" },
                { regex: /\b(X5C8[A-Z0-9]{8,10})\b/g, type: "Valor VP800" },
                { regex: /\b(P125\d{10,12})\b/g, type: "Dejavoo P1" },
                { regex: /\b(P325\d{10,12})\b/g, type: "Dejavoo P3" },
                { regex: /\b(P524\d{10,12})\b/g, type: "Dejavoo P5" },
                { regex: /\b(P17[B86]\d{10,12})\b/g, type: "Dejavoo P17" }
            ];

            patterns.forEach(p => {
                let match;
                while ((match = p.regex.exec(text)) !== null) {
                    const sn = match[1].toUpperCase();
                    if (!seenSerials.has(sn)) {
                        finalItems.push({ serial_number: sn, terminal_type: p.type });
                        seenSerials.add(sn);
                    }
                }
            });
        }

        if (finalItems.length === 0) {
            return sendJsonError(422, "No serial numbers found. Try splitting the PDF.");
        }

        return res.status(200).json({ success: true, data: finalItems });

    } catch (err) {
        console.error("AI Exception:", err);
        return sendJsonError(500, `Processing Error: ${err.message}`);
    }
}
