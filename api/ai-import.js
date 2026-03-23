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
        
        // Using gemini-2.0-flash: The fastest model currently available in the preview environment.
        // This model has the lowest "Time to First Token", crucial for beating Vercel's 10s timeout.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash",
            generationConfig: {
                temperature: 0,
            }
        });

        // Prompt designed for maximum speed: stop thinking, start dumping.
        const prompt = `
            DUMP ALL SERIAL NUMBERS. 
            Look for: 18125..., X5C8..., P125..., P325..., P524..., P17B...
            List every matching string separated by spaces. No other text.
        `;

        // 9-second timeout watchdog (Vercel kills at 10s)
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
                return sendJsonError(504, "Server timeout (10s). The document is too dense. Please try converting this PDF page to a JPG and upload that instead, as images process faster.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();

        // --- THE "SPEED-LIMIT" HARVESTER ---
        // We use local regex to classify models instantly so the AI doesn't have to.
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

        // Fallback: If no exact prefix match, grab any 10-15 character alphanumeric block
        if (items.length === 0) {
            const fallbackRegex = /\b[A-Z0-9]{10,16}\b/g;
            const matches = upperText.match(fallbackRegex) || [];
            matches.forEach(sn => {
                if (!seenSerials.has(sn)) {
                    items.push({ 
                        serial_number: sn, 
                        terminal_type: upperText.includes('VALOR') ? "Valor" : "Dejavoo" 
                    });
                    seenSerials.add(sn);
                }
            });
        }

        if (items.length === 0) {
            return sendJsonError(422, "No serial numbers identified. Raw text preview: " + rawText.substring(0, 50));
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("Critical AI Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
