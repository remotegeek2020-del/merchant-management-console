import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

// Exponential backoff helper for free-tier stability
const wait = (ms) => new Promise(res => setTimeout(res, ms));

async function callGeminiWithRetry(model, content, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await model.generateContent(content);
            return result;
        } catch (err) {
            if (i === retries - 1) throw err;
            await wait(1000); // 1s wait before retry
        }
    }
}

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
        
        // Use gemini-1.5-flash for the highest stability across different API keys
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
            }
        });

        // "No-Reasoning" Prompt: This ensures the AI doesn't spend 5 seconds "thinking"
        // before it starts outputting text.
        const prompt = `
            EXTRACT SERIAL NUMBERS.
            Patterns: 18125..., X5C8..., P125..., P325..., P524..., P17B...
            FORMAT: Just a comma-separated list of every long serial number found.
            Do not provide model names or intro text.
        `;

        // Watchdog: 8.5 seconds to return before Vercel's 10s kill switch
        const aiRequest = callGeminiWithRetry(model, [
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('VERCEL_TIMEOUT')), 8500)
        );

        let rawText = "";
        try {
            const result = await Promise.race([aiRequest, timeoutPromise]);
            const response = await result.response;
            rawText = response.text().trim();
        } catch (err) {
            if (err.message === 'VERCEL_TIMEOUT') {
                return sendJsonError(504, "Server connection timed out (10s limit). Please split the document into smaller parts or try a single page.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();

        // --- THE "BRUTE FORCE" REGEX HARVESTER ---
        // This is 1000x faster than AI classification.
        const patterns = [
            { regex: /\b(18125\d{7})\b/g, type: "Valor VL550" },
            { regex: /\b(X5C8[A-Z0-9]{8,12})\b/g, type: "Valor VP800" },
            { regex: /\b(P125\d{10,13})\b/g, type: "Dejavoo P1" },
            { regex: /\b(P325\d{10,13})\b/g, type: "Dejavoo P3" },
            { regex: /\b(P524\d{10,13})\b/g, type: "Dejavoo P5" },
            { regex: /\b(P17[B86]\d{10,13})\b/g, type: "Dejavoo P17" }
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

        // Final Fallback: Grab any alphanumeric string of serial-like length (10-16 chars)
        if (items.length === 0) {
            const broadRegex = /\b[A-Z0-9]{10,16}\b/g;
            const matches = upperText.match(broadRegex) || [];
            matches.forEach(sn => {
                if (!seenSerials.has(sn)) {
                    const isValor = upperText.includes('18125') || upperText.includes('VALOR');
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
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
