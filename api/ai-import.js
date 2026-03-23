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
        
        // Use gemini-1.5-flash for the highest stability.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0.1, // Slight temperature can sometimes help avoid "stuck" empty responses
            }
        });

        // We ask for a simple comma-separated list. 
        // We add "IGNORE TABLE HEADERS" to help it focus.
        const prompt = `
            ACT AS AN OCR ENGINE. EXTRACT EVERY SERIAL NUMBER.
            Look for: 18125..., X5C8..., P125..., P325..., P524..., P17B...
            FORMAT: Output ONLY the serial numbers found, separated by commas.
            Do not provide model names, descriptions, or conversation.
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
                return sendJsonError(504, "Vercel Timeout (10s). The PDF is too complex. Try splitting it into 1-page files or converting to JPG.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();

        // --- THE "SURVIVAL" REGEX HARVESTER ---
        // This regex is refined to match the exact patterns in your files.
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

        // --- LAYER 2: BRUTE FORCE ALPHANUMERIC SCAN ---
        // If the specific prefixes didn't work, we grab anything 10-16 chars long 
        // that looks like a serial and try to guess the type.
        if (items.length === 0) {
            const broadRegex = /\b([A-Z0-9]{10,16})\b/g;
            const matches = upperText.match(broadRegex) || [];
            
            matches.forEach(sn => {
                if (!seenSerials.has(sn)) {
                    let type = "Terminal";
                    if (sn.startsWith('1812') || upperText.includes('VALOR')) type = "Valor VL550";
                    else if (sn.startsWith('P')) type = "Dejavoo";
                    
                    items.push({ serial_number: sn, terminal_type: type });
                    seenSerials.add(sn);
                }
            });
        }

        if (items.length === 0) {
            // Return the first 200 characters of what the AI said so we can debug.
            const debugSnippet = rawText.length > 0 ? rawText.substring(0, 200) : "EMPTY_RESPONSE";
            return sendJsonError(422, "No serials identified. AI Response: " + debugSnippet);
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
