import { GoogleGenerativeAI } from "@google/generative-ai";

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
        
        // Use gemini-1.5-flash for the fastest "Time to First Token".
        // We REMOVE responseMimeType: "application/json" because it adds significant
        // latency as the AI "plans" the JSON structure, which causes Vercel timeouts.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                maxOutputTokens: 8192
            }
        });

        const prompt = `
            EXTRACT EVERY SERIAL NUMBER FROM THIS DOCUMENT.
            
            DIRECTIONS:
            1. Find 12-digit strings starting with 18125 or alphanumeric starting with X5C8 (Valor).
            2. Find strings starting with P125, P325, P524, or P17B (Dejavoo).
            
            OUTPUT:
            Just list the serial numbers one per line. Do not add any text, headers, or markdown.
            Example:
            181251934334
            P1250920000034
        `;

        // Watchdog: 9 seconds. Vercel kills at 10s.
        const aiRequest = model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('VERCEL_TIMEOUT')), 9000)
        );

        let rawText = "";
        try {
            const result = await Promise.race([aiRequest, timeoutPromise]);
            const response = await result.response;
            rawText = response.text().trim();
        } catch (err) {
            if (err.message === 'VERCEL_TIMEOUT') {
                return sendJsonError(504, "The document is too large for the 10-second limit. Please split the PDF into single pages.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();

        // --- THE "SURGICAL" REGEX HARVESTER ---
        // We scan the raw text for prefixes we know are in your Dejavoo and Valor files.
        const patterns = [
            { regex: /\b(18125\d{7})\b/g, type: "Valor VL550" },
            { regex: /\b(X5C8[A-Z0-9]{8,12})\b/g, type: "Valor VP800" },
            { regex: /\b(P125\d{10,12})\b/g, type: "Dejavoo P1" },
            { regex: /\b(P325\d{10,12})\b/g, type: "Dejavoo P3" },
            { regex: /\b(P524\d{10,12})\b/g, type: "Dejavoo P5" },
            { regex: /\b(P17[B86]\d{10,12})\b/g, type: "Dejavoo P17" }
        ];

        patterns.forEach(p => {
            let match;
            const upperText = rawText.toUpperCase();
            while ((match = p.regex.exec(upperText)) !== null) {
                const sn = match[1];
                if (!seenSerials.has(sn)) {
                    items.push({ serial_number: sn, terminal_type: p.type });
                    seenSerials.add(sn);
                }
            }
        });

        // If the specific harvester failed, try a broad alphanumeric scrape
        if (items.length === 0) {
            const broadRegex = /\b[A-Z0-9]{10,15}\b/g;
            const matches = rawText.toUpperCase().match(broadRegex) || [];
            matches.forEach(sn => {
                if (!seenSerials.has(sn)) {
                    let type = rawText.includes('1812') ? "Valor" : "Dejavoo";
                    items.push({ serial_number: sn, terminal_type: type });
                    seenSerials.add(sn);
                }
            });
        }

        if (items.length === 0) {
            return sendJsonError(422, "No serial numbers were found in the response. Raw output sample: " + rawText.substring(0, 50));
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
