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
        
        // Use gemini-1.5-flash: The fastest model for "first-token" response times.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                // We do NOT use responseMimeType: "application/json" because it causes 
                // the AI to pre-calculate the whole list, leading to Vercel timeouts.
            }
        });

        // Simplified prompt for raw text dumping
        const prompt = `
            OCR TASK: Extract all hardware serial numbers.
            Focus on strings like: 18125..., X5C8..., P125..., P325..., P524..., P17B...
            
            OUTPUT: Just the serial numbers separated by commas. No intro, no outro.
        `;

        // Watchdog: 8.8 seconds. Vercel Hobby tier kills at 10s.
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
                return sendJsonError(504, "The document is too large for the 10-second limit. Please split the PDF into single pages.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();

        // --- LOCAL IDENTIFICATION LOGIC (Instant) ---
        // Instead of asking the AI to "classify", we do it here.
        const patterns = [
            { regex: /\b(18125\d{7})\b/g, type: "Valor VL550" },
            { regex: /\b(X5C8[A-Z0-9]{8,12})\b/g, type: "Valor VP800" },
            { regex: /\b(P125\d{10,12})\b/g, type: "Dejavoo P1" },
            { regex: /\b(P325\d{10,12})\b/g, type: "Dejavoo P3" },
            { regex: /\b(P524\d{10,12})\b/g, type: "Dejavoo P5" },
            { regex: /\b(P17[B86]\d{10,12})\b/g, type: "Dejavoo P17" }
        ];

        // First pass: Match specific prefixes
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

        // Fallback: If AI just dumped raw text and prefix regex missed, 
        // search for any 10-15 char blocks and guess based on keywords
        if (items.length === 0) {
            const broadRegex = /\b[A-Z0-9]{10,16}\b/g;
            const matches = upperText.match(broadRegex) || [];
            const isValor = upperText.includes('VALOR') || upperText.includes('1812');
            
            matches.forEach(sn => {
                if (!seenSerials.has(sn)) {
                    items.push({ 
                        serial_number: sn, 
                        terminal_type: isValor ? "Valor" : "Dejavoo" 
                    });
                    seenSerials.add(sn);
                }
            });
        }

        if (items.length === 0) {
            return sendJsonError(422, "The AI responded but no serial numbers were recognized. Raw response: " + rawText.substring(0, 50));
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
