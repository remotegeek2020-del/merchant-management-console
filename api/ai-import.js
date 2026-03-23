import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

export default async function handler(req, res) {
    // Utility to log and send errors consistently
    const sendJsonError = (status, message, raw = null) => {
        return res.status(status).json({ success: false, message, raw });
    };

    if (req.method !== 'POST') return sendJsonError(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY) return sendJsonError(500, 'API Key Missing');

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return sendJsonError(400, 'No file data received.');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Use gemini-1.5-flash: It is the most robust and fastest for high-density OCR.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                // We do NOT use JSON mode here because it adds "thinking time" overhead 
                // that leads to Vercel timeouts. We want the fastest raw text.
            }
        });

        // Simplified prompt to reduce AI processing time
        const prompt = `
            LIST EVERY SERIAL NUMBER FOUND. 
            Example format: P1250920000034, 181251934334, X5C800029972
            Just a comma-separated list of every long number you see.
        `;

        // Create a promise for the AI call
        const aiTask = model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        // Race the AI task against a 9-second timeout (Vercel limit is 10s)
        const result = await Promise.race([
            aiTask,
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_REACHED')), 9000))
        ]);

        const response = await result.response;
        const rawText = response.text().trim();
        
        const items = [];
        const seenSerials = new Set();

        // --- THE UNIVERSAL HARVESTER ---
        // This scans the raw AI response for patterns found in your Valor/Dejavoo files.
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

        if (items.length === 0) {
            return sendJsonError(422, "The AI responded but no serial numbers were found. Check your file format.", rawText);
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        if (err.message === 'TIMEOUT_REACHED') {
            return sendJsonError(504, "The document is too large for the current plan. Please split the PDF into single pages.");
        }
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
