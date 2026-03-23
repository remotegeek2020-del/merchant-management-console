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
        
        // Use gemini-2.0-flash-001 for the fastest "Time to First Token".
        // This is crucial for staying under Vercel's 10s Hobby tier limit.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash-001",
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
            }
        });

        // Prompt optimized for speed and strict JSON structure
        const prompt = `
            EXTRACT ALL SERIAL NUMBERS.
            Patterns: 18125..., X5C8..., P125..., P325..., P524..., P17B...
            
            Return JSON in this format:
            {"items": [{"sn": "SERIAL", "type": "MODEL"}]}
            
            Models to use: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
        `;

        // Watchdog: 8.8 seconds to return before Vercel's 10s kill switch
        const aiRequest = callGeminiWithRetry(model, [
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
                return sendJsonError(504, "Connection timed out. For invoices with 100+ units, please upload one page at a time or use a JPG image.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();

        // --- LAYER 1: STRICT JSON PARSE ---
        try {
            const parsed = JSON.parse(rawText);
            const rawArray = parsed.items || (Array.isArray(parsed) ? parsed : []);
            rawArray.forEach(item => {
                const sn = String(item.sn || item.serial_number || "").replace(/[.,\s]/g, "").toUpperCase();
                if (sn.length >= 8 && !seenSerials.has(sn)) {
                    items.push({ 
                        serial_number: sn, 
                        terminal_type: item.type || item.terminal_type || "Terminal" 
                    });
                    seenSerials.add(sn);
                }
            });
        } catch (e) {
            console.warn("JSON Parse failed, attempting raw text recovery...");
        }

        // --- LAYER 2: SURVIVAL REGEX HARVESTER ---
        // If the JSON failed or was truncated, we scan the raw text for matches
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

        if (items.length === 0) {
            const debugSnippet = rawText.length > 0 ? rawText.substring(0, 100) : "EMPTY";
            return sendJsonError(422, "No serials identified. AI Response snippet: " + debugSnippet);
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
