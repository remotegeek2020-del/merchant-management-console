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
        
        // Use gemini-1.5-flash. It's the workhorse of the Free Tier.
        // We set a slightly higher temperature to encourage the model to 
        // start outputting text immediately to avoid connection timeouts.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0.1,
            }
        });

        const prompt = `
            Extract ALL hardware serial numbers from the attached PDF. 
            Focus on these specific patterns:
            - Valor: 12-digit numbers starting with 18125 or alphanumeric starting with X5C8.
            - Dejavoo: 14+ character strings starting with P125, P325, P524, or P17B.
            
            Do not worry about JSON or formatting. Just list the serial numbers and their model names.
            I will use a script to find them in your response.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text();
        
        // --- THE "UNSTOPPABLE" REGEX HARVESTER ---
        // This engine doesn't care what the AI thinks or how it formats.
        // it scans the raw text response for the actual data patterns.
        const items = [];
        const seenSerials = new Set();

        const patterns = [
            { regex: /\b(18125\d{7})\b/g, type: "Valor VL550" },
            { regex: /\b(X5C8[A-Z0-9]{8,10})\b/g, type: "Valor VP800" },
            { regex: /\b(P125\d{10,12})\b/g, type: "Dejavoo P1" },
            { regex: /\b(P325\d{10,12})\b/g, type: "Dejavoo P3" },
            { regex: /\b(P524\d{10,12})\b/g, type: "Dejavoo P5" },
            { regex: /\b(P17[B86]\d{10,12})\b/g, type: "Dejavoo P17" }
        ];

        // Harvest data from the AI's response
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

        // Fallback for messy lists (finding serials in "SN: P123 | Type: P1" format)
        if (items.length === 0) {
            const lines = rawText.split('\n');
            lines.forEach(line => {
                if (line.includes('|') || line.includes(':') || line.includes('-')) {
                    const parts = line.split(/[|:-]/);
                    const sn = parts[0].trim().replace(/[.,\s]/g, "").toUpperCase();
                    let type = parts[1]?.trim() || "Terminal";
                    if (sn.length >= 8 && !seenSerials.has(sn)) {
                        items.push({ serial_number: sn, terminal_type: type });
                        seenSerials.add(sn);
                    }
                }
            });
        }

        if (items.length === 0) {
            console.error("No serials found. AI raw output:", rawText);
            return sendJsonError(422, "The AI couldn't find any serial numbers in this document. Please check the PDF quality.");
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI Exception:", err);
        return sendJsonError(500, `Processing Error: ${err.message}`);
    }
}
