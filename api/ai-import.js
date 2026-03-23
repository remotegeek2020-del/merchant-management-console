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
        
        // Use 1.5-flash: Best for high-volume extraction on Free Tier.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                // We avoid strict JSON mode because it fails completely if the 
                // response is truncated (very common with 170+ items).
            }
        });

        const prompt = `
            Act as a data extraction tool. Extract EVERY serial number from this PDF.
            
            DIRECTIONS:
            1. VALOR: Extract 12-digit strings (starting with 1812 or X5C) from comma-separated blocks.
            2. DEJAVOO: Match serials (starting with P125, P325, P524, P17B) to models (P1, P3, P5, P17).
            
            OUTPUT FORMAT (MANDATORY):
            For every serial number found, output a single line exactly like this:
            SERIAL_NUMBER | MODEL_NAME
            
            Example:
            P1250920000034 | Dejavoo P1
            181251934334 | Valor VL550
            
            Do not include headers, intros, or markdown. Just the data lines. 
            Keep going until you have listed every single item in the document.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text();
        
        // --- THE "PIPE" SCRAPER ---
        // This is the most resilient way to parse large amounts of AI data.
        // It processes line-by-line and ignores malformed ones.
        const lines = rawText.split('\n');
        const items = [];
        const seenSerials = new Set();

        for (let line of lines) {
            line = line.trim();
            if (!line || !line.includes('|')) continue;

            // Split by the pipe character
            const parts = line.split('|');
            if (parts.length < 2) continue;

            const sn = parts[0].trim().replace(/[.,\s]/g, "").toUpperCase();
            let type = parts[1].trim();

            // Clean up common model name noise
            if (type.toLowerCase().includes("p1") && !type.includes("P17")) type = "Dejavoo P1";
            else if (type.toLowerCase().includes("p3")) type = "Dejavoo P3";
            else if (type.toLowerCase().includes("p5")) type = "Dejavoo P5";
            else if (type.toLowerCase().includes("p17")) type = "Dejavoo P17";
            else if (type.toLowerCase().includes("vl-550") || type.toLowerCase().includes("vl550")) type = "Valor VL550";
            else if (type.toLowerCase().includes("vp800")) type = "Valor VP800";

            if (sn.length >= 8 && !seenSerials.has(sn)) {
                items.push({ serial_number: sn, terminal_type: type });
                seenSerials.add(sn);
            }
        }

        // --- EMERGENCY REGEX HARVESTER ---
        // If the formatted lines failed, we scan the whole text for known serial patterns.
        if (items.length === 0) {
            const snRegex = /\b(P125|P325|P524|P17B|P178|P176|1812|X5C)[A-Z0-9]{6,12}\b/g;
            const matches = rawText.match(snRegex) || [];
            
            let defaultType = rawText.toLowerCase().includes("valor") ? "Valor VL550" : "Dejavoo P1";

            matches.forEach(sn => {
                const cleanSn = sn.toUpperCase();
                if (!seenSerials.has(cleanSn)) {
                    items.push({ serial_number: cleanSn, terminal_type: defaultType });
                    seenSerials.add(cleanSn);
                }
            });
        }

        if (items.length === 0) {
            return sendJsonError(422, "No items found. Ensure the PDF has selectable text.");
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI Exception:", err);
        return sendJsonError(500, "The server timed out or the file is too complex. Try splitting the PDF.");
    }
}
