import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

const wait = (ms) => new Promise(res => setTimeout(res, ms));

async function callGeminiWithRetry(model, content, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            const result = await model.generateContent(content);
            return result;
        } catch (err) {
            if (i === retries - 1) throw err;
            await wait(1000);
        }
    }
}

export default async function handler(req, res) {
    const sendJsonError = (status, message) => {
        return res.status(status).json({ success: false, message });
    };

    if (req.method !== 'POST') return sendJsonError(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY) return sendJsonError(500, 'API Key Missing');

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return sendJsonError(400, 'No file data received.');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Using stable flash model for document processing
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash", 
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
            }
        });

        // FIXED: Only ONE declaration of timeoutPromise allowed
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('VERCEL_TIMEOUT')), 9200)
        );

        const prompt = `
            INVOICE DATA EXTRACTION:
            1. Find Invoice Date (YYYY-MM-DD).
            2. List every Serial Number and its corresponding Model Name.
            3. Ignore non-hardware items (like 'Shipping' or 'KeyLoad').

            OUTPUT ONLY VALID JSON:
            {"invoice_date": "YYYY-MM-DD", "data": [{"serial_number": "SN", "terminal_type": "MODEL"}]}
        `;

        const aiRequest = callGeminiWithRetry(model, [
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        let rawText = "";
        let invoiceDate = new Date().toISOString().split('T')[0];

        try {
            const result = await Promise.race([aiRequest, timeoutPromise]);
            const response = await result.response;
            rawText = response.text().trim();
        } catch (err) {
            if (err.message === 'VERCEL_TIMEOUT') {
                return sendJsonError(504, "Connection timed out. Please try a smaller file.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();

        try {
            const parsed = JSON.parse(rawText);
            if (parsed.invoice_date) invoiceDate = parsed.invoice_date;

            const rawArray = parsed.data || parsed.items || (Array.isArray(parsed) ? parsed : []);
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
            console.warn("Regex recovery triggered.");
        }

        // Regex patterns for Dejavoo and Valor
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

        return res.status(200).json({ 
            success: true, 
            invoice_date: invoiceDate, 
            data: items 
        });

    } catch (err) {
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
