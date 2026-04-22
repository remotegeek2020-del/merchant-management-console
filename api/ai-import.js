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
        
      // Replace the model configuration (approx. lines 44-51)
// Locate and replace approx. lines 44-55
// 1. Update to Gemini 3 Flash (approx. line 45)
// Inside api/ai-import.js
// FIX: Use the specific Preview/Experimental ID recognized by the v1beta API
// FIX: Use the specific Preview/Experimental ID recognized by the v1beta API
const model = genAI.getGenerativeModel({ 
    model: "gemini-3.1-flash-lite", // This is the most stable 'latest' ID for Gemini 3 technology currently
    generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
    }
});

const prompt = `
    INSTRUCTIONS: Scan the attached document and extract all Terminal/POS Serial Numbers and their Models.
    
    Return ONLY a JSON object with this exact structure:
    {"data": [{"serial_number": "STRING", "terminal_type": "STRING"}]}
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
