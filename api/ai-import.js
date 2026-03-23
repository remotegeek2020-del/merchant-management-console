import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

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
        
        // Switching to 1.5-flash-8b: The fastest and most reliable for long lists on Free Tier.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash-8b",
            generationConfig: {
                temperature: 0,
            }
        });

        const prompt = `
            Extract ALL hardware serial numbers from this PDF.
            
            FORMAT: Just list the serial numbers followed by the model name, one per line.
            Example:
            181251934334 - Valor VL550
            P1250920000034 - Dejavoo P1
            
            VENDOR PATTERNS:
            - Valor: 12-digit numbers starting with 18125 or alphanumeric starting with X5C8.
            - Dejavoo: Serials starting with P125, P325, P524, or P17B.
            
            Capture every single number found in the document.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text();
        
        const items = [];
        const seenSerials = new Set();

        // --- THE "UNIVERSAL" EXTRACTOR ---
        // We look for the patterns directly in the AI's response text.
        // This regex covers all prefixes seen in your Valor and Dejavoo samples.
        const patterns = [
            { regex: /\b(18125\d{7})\b/g, type: "Valor VL550" },
            { regex: /\b(X5C8[A-Z0-9]{8})\b/g, type: "Valor VP800" },
            { regex: /\b(P125\d{10})\b/g, type: "Dejavoo P1" },
            { regex: /\b(P325\d{10})\b/g, type: "Dejavoo P3" },
            { regex: /\b(P524\d{10})\b/g, type: "Dejavoo P5" },
            { regex: /\b(P17B\d{11})\b/g, type: "Dejavoo P17" },
            { regex: /\b(P17[86]\d{11})\b/g, type: "Dejavoo P17" } // Catch OCR typos like P178 or P176
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

        // --- SECONDARY PARSE: Line-by-line split ---
        if (items.length === 0) {
            const lines = rawText.split('\n');
            for (let line of lines) {
                if (line.includes('-') || line.includes('|') || line.includes(':')) {
                    const parts = line.split(/[-|:]/);
                    if (parts.length >= 2) {
                        const sn = parts[0].trim().replace(/[.,\s]/g, "").toUpperCase();
                        let type = parts[1].trim();
                        if (sn.length >= 8 && !seenSerials.has(sn)) {
                            items.push({ serial_number: sn, terminal_type: type });
                            seenSerials.add(sn);
                        }
                    }
                }
            }
        }

        if (items.length === 0) {
            console.error("No items found. AI Response was:", rawText);
            return sendJsonError(422, "The AI couldn't find a list of serial numbers. Ensure the PDF is clear.");
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI Exception:", err);
        return sendJsonError(500, "The server timed out. Try splitting the PDF into separate pages.");
    }
}
