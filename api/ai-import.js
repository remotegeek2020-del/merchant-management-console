import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

// Exponential backoff helper
const wait = (ms) => new Promise(res => setTimeout(res, ms));

async function callGeminiWithRetry(model, content, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await model.generateContent(content);
            return result;
        } catch (err) {
            // If it's the last retry, throw the error
            if (i === retries - 1) throw err;
            // Otherwise wait (1s, 2s, 4s...)
            await wait(Math.pow(2, i) * 1000);
        }
    }
}

export default async function handler(req, res) {
    const sendJsonError = (status, message, raw = null) => {
        return res.status(status).json({ success: false, message, raw });
    };

    if (req.method !== 'POST') return sendJsonError(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY) return sendJsonError(500, 'API Key Missing');

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return sendJsonError(400, 'No file data received.');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Use gemini-1.5-flash: Highest reliability for high-density document tasks.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0.1,
            }
        });

        const prompt = `
            EXTRACT ALL HARDWARE SERIAL NUMBERS. 
            
            Look for these specific patterns:
            - Valor: 12-digit numbers starting with 18125 or strings like X5C8...
            - Dejavoo: 14+ char strings starting with P125, P325, P524, or P17B.
            
            List them exactly like this:
            SERIAL: [the number]
            TYPE: [the terminal model]
            ---
        `;

        // Execute AI task with internal retry logic
        const result = await callGeminiWithRetry(model, [
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text().trim();
        
        const items = [];
        const seenSerials = new Set();

        // --- LAYER 1: PATTERN HARVESTER ---
        // This is the most reliable way to extract data from a noisy AI response.
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
            while ((match = p.regex.exec(rawText)) !== null) {
                const sn = match[1].toUpperCase();
                if (!seenSerials.has(sn)) {
                    items.push({ serial_number: sn, terminal_type: p.type });
                    seenSerials.add(sn);
                }
            }
        });

        // --- LAYER 2: LINE PARSER FALLBACK ---
        if (items.length === 0) {
            const lines = rawText.split('\n');
            let currentSn = null;
            for (let line of lines) {
                const upper = line.toUpperCase();
                if (upper.includes('SERIAL:')) {
                    currentSn = line.split(':')[1]?.trim().replace(/[.,\s]/g, "");
                } else if (upper.includes('TYPE:') && currentSn) {
                    const type = line.split(':')[1]?.trim();
                    if (!seenSerials.has(currentSn)) {
                        items.push({ serial_number: currentSn, terminal_type: type });
                        seenSerials.add(currentSn);
                    }
                    currentSn = null;
                }
            }
        }

        if (items.length === 0) {
            return sendJsonError(422, "No serial numbers were found. Ensure the PDF is a high-quality digital document.", rawText);
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI System Error:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
