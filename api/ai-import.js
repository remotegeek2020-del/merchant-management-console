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
        
        // Use gemini-1.5-flash with forced JSON output.
        // This is the most stable configuration for high-volume data extraction.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
            }
        });

        const prompt = `
            Act as a precise data extraction tool for payment terminal inventory.
            
            TASK: Extract EVERY hardware serial number from the attached PDF.
            
            MAPPING RULES:
            - If item is VL-550 or VP800 -> terminal_type: "Valor VL550" or "Valor VP800"
            - If item is KOZ-P1, Koz-P3, Koz-P5, or KOZ-P17 -> terminal_type: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", or "Dejavoo P17"
            
            EXTRACTION LOGIC:
            - VALOR: Serial numbers are in comma-separated lists (e.g., 18125...).
            - DEJAVOO: Serial numbers are in a dedicated table, often matching a Line/Part No. index (1, 2, 3...).
            
            OUTPUT:
            Return a JSON object with a key "items" containing the array: {"items": [{"serial_number": "...", "terminal_type": "..."}]}
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text().trim();
        
        let finalItems = [];
        const seenSerials = new Set();

        // --- LAYER 1: STRICT JSON PARSE ---
        try {
            const parsed = JSON.parse(rawText);
            const rawArray = parsed.items || (Array.isArray(parsed) ? parsed : []);
            
            rawArray.forEach(item => {
                const sn = String(item.serial_number || "").replace(/[.,\s]/g, "").toUpperCase();
                if (sn.length >= 8 && !seenSerials.has(sn)) {
                    finalItems.push({
                        serial_number: sn,
                        terminal_type: item.terminal_type || "Terminal"
                    });
                    seenSerials.add(sn);
                }
            });
        } catch (e) {
            console.warn("JSON Parse failed, trying Pattern Harvester fallback...");
        }

        // --- LAYER 2: PATTERN HARVESTER FALLBACK ---
        // If the JSON was truncated or malformed, we scan the raw text for matches
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
            while ((match = p.regex.exec(rawText)) !== null) {
                const sn = match[1].toUpperCase();
                if (!seenSerials.has(sn)) {
                    finalItems.push({ serial_number: sn, terminal_type: p.type });
                    seenSerials.add(sn);
                }
            }
        });

        if (finalItems.length === 0) {
            console.error("Extraction failure. AI Response:", rawText);
            return sendJsonError(422, "The AI couldn't find any serial numbers. Ensure the PDF is clear and readable.");
        }

        return res.status(200).json({ success: true, data: finalItems });

    } catch (err) {
        console.error("AI Exception:", err);
        return sendJsonError(500, `Processing Error: ${err.message}`);
    }
}
