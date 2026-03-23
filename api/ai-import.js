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
            if (i === retries - 1) throw err;
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
        
        // Use gemini-1.5-flash for maximum speed and stability.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
            }
        });

        const prompt = `
            ACT AS A HIGH-SPEED OCR SCANNER.
            TASK: FIND EVERY SERIAL NUMBER IN THIS DOCUMENT.
            
            Look for:
            - 12-digit numbers (Valor)
            - 14-16 character alphanumeric strings starting with P (Dejavoo)
            - Alphanumeric strings starting with X5 (Valor)
            
            Format your output as a simple list:
            SN: [number] | TYPE: [model]
            
            MODELS: Dejavoo P1, Dejavoo P3, Dejavoo P5, Dejavoo P17, Valor VL550, Valor VP800.
        `;

        const result = await callGeminiWithRetry(model, [
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text().trim();
        
        const items = [];
        const seenSerials = new Set();

        // --- BRUTE FORCE HARVESTER ---
        // This regex catches almost any string that looks like a serial number from your vendors.
        const broadRegex = /\b([A-Z0-9]{10,16})\b/g;
        let match;
        
        while ((match = broadRegex.exec(rawText.toUpperCase())) !== null) {
            const sn = match[1].replace(/[.,\s]/g, "");
            
            // Determine type based on prefix
            let type = "Terminal";
            if (sn.startsWith('1812')) type = "Valor VL550";
            else if (sn.startsWith('X5C8')) type = "Valor VP800";
            else if (sn.startsWith('P125')) type = "Dejavoo P1";
            else if (sn.startsWith('P325')) type = "Dejavoo P3";
            else if (sn.startsWith('P524')) type = "Dejavoo P5";
            else if (sn.startsWith('P17')) type = "Dejavoo P17";
            
            // Only add if it's a valid length for these specific serials
            if (sn.length >= 10 && !seenSerials.has(sn)) {
                items.push({ serial_number: sn, terminal_type: type });
                seenSerials.add(sn);
            }
        }

        // --- SECONDARY LINE SCAN ---
        if (items.length === 0) {
            const lines = rawText.split('\n');
            lines.forEach(line => {
                if (line.includes('|') || line.includes(':')) {
                    const parts = line.split(/[|:]/);
                    const sn = parts[1]?.trim().split(' ')[0].replace(/[.,\s]/g, "").toUpperCase();
                    if (sn && sn.length >= 10 && !seenSerials.has(sn)) {
                        items.push({ 
                            serial_number: sn, 
                            terminal_type: line.toLowerCase().includes('valor') ? 'Valor' : 'Dejavoo'
                        });
                        seenSerials.add(sn);
                    }
                }
            });
        }

        if (items.length === 0) {
            console.error("No serials found. AI raw output:", rawText);
            return sendJsonError(422, "No serial numbers were found in the AI response.", rawText);
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI System Error:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
