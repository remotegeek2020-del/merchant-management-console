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
        
        // Use 1.5-flash-8b: It is the fastest possible model. 
        // Latency is the enemy of the 10-second Vercel limit.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash-8b",
            generationConfig: {
                temperature: 0,
            }
        });

        // We ask for the simplest possible text dump. 
        // No commas, no JSON, no formatting. Just raw strings.
        const prompt = `
            DUMP EVERY SERIAL NUMBER. 
            Prefixes: 18125, X5C8, P125, P325, P524, P17B.
            Just list the numbers. One per line. Do not say anything else.
        `;

        // Watchdog: 8.8 seconds. Vercel kills at 10s.
        const aiRequest = model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('VERCEL_TIMEOUT')), 8800)
        );

        let rawText = "";
        try {
            const result = await Promise.race([aiRequest, timeoutPromise]);
            const response = await result.response;
            rawText = response.text().trim();
        } catch (err) {
            if (err.message === 'VERCEL_TIMEOUT') {
                return sendJsonError(504, "Vercel 10s limit reached. Please use the split version of the PDF.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();

        // --- THE "SPEED" HARVESTER ---
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
            while ((match = p.regex.exec(rawText.toUpperCase())) !== null) {
                const sn = match[1];
                if (!seenSerials.has(sn)) {
                    items.push({ serial_number: sn, terminal_type: p.type });
                    seenSerials.add(sn);
                }
            }
        });

        if (items.length === 0) {
            // If regex failed, try a last-resort alphanumeric grabber
            const fallbackRegex = /\b[A-Z0-9]{10,16}\b/g;
            const matches = rawText.match(fallbackRegex) || [];
            matches.forEach(sn => {
                if (!seenSerials.has(sn)) {
                    items.push({ 
                        serial_number: sn, 
                        terminal_type: rawText.includes('1812') ? "Valor" : "Dejavoo" 
                    });
                    seenSerials.add(sn);
                }
            });
        }

        if (items.length === 0) {
            return sendJsonError(422, "No serials found. AI Response: " + rawText.substring(0, 100));
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
