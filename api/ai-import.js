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
        
        // Use gemini-1.5-flash: It has the fastest "Time to First Token" on the free tier.
        // We avoid 2.0-flash here as it can sometimes be more strictly rate-limited 
        // or have longer "pre-computation" times for large files.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
            }
        });

        // "Zero-Format" Prompt: Forces the AI to skip the 'planning' phase.
        // This is the fastest way to get data out of Gemini.
        const prompt = `
            DUMP ALL SERIAL NUMBERS. 
            Patterns to find: 18125..., X5C8..., P125..., P325..., P524..., P17B...
            List them separated by spaces or commas. Do not use JSON. Do not use Markdown. 
            Start listing immediately.
        `;

        // 9-second watchdog for Vercel's 10-second limit
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
                return sendJsonError(504, "Server connection timed out (10s limit). The document is too large for a single request. Please split the document into smaller parts.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();

        // --- THE "SURVIVAL" SCRAPER ---
        // We do the classification locally in JS (0ms) rather than in the AI (3000ms+).
        const patterns = [
            { regex: /\b(18125\d{7})\b/g, type: "Valor VL550" },
            { regex: /\b(X5C8[A-Z0-9]{8,12})\b/g, type: "Valor VP800" },
            { regex: /\b(P125\d{10,12})\b/g, type: "Dejavoo P1" },
            { regex: /\b(P325\d{10,12})\b/g, type: "Dejavoo P3" },
            { regex: /\b(P524\d{10,12})\b/g, type: "Dejavoo P5" },
            { regex: /\b(P17[B86]\d{10,12})\b/g, type: "Dejavoo P17" }
        ];

        const upperText = rawText.toUpperCase();
        
        patterns.forEach(p => {
            let match;
            while ((match = p.regex.exec(upperText)) !== null) {
                const sn = match[1];
                if (!seenSerials.has(sn)) {
                    items.push({ serial_number: sn, terminal_type: p.type });
                    seenSerials.add(sn);
                }
            }
        });

        // Fallback: Broad search for any 10-16 char alphanumeric block
        if (items.length === 0) {
            const fallbackRegex = /\b[A-Z0-9]{10,16}\b/g;
            const matches = upperText.match(fallbackRegex) || [];
            matches.forEach(sn => {
                if (!seenSerials.has(sn)) {
                    const isValor = upperText.includes('VALOR') || upperText.includes('18125');
                    items.push({ 
                        serial_number: sn, 
                        terminal_type: isValor ? "Valor" : "Dejavoo" 
                    });
                    seenSerials.add(sn);
                }
            });
        }

        if (items.length === 0) {
            return sendJsonError(422, "No serial numbers were found in the AI response.", rawText.substring(0, 100));
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI Import Error:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
