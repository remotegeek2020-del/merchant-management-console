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
        
        // Use the standard gemini-1.5-flash which has the highest compatibility 
        // across all Free Tier accounts.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
            }
        });

        const prompt = `
            Act as a precise data extraction tool for payment terminal inventory.
            
            TASK: Extract EVERY hardware serial number from this PDF.
            
            VENDORS & PATTERNS:
            - VALOR: 12-digit numbers starting with 18125 OR alphanumeric starting with X5C8.
            - DEJAVOO: Strings starting with P125, P325, P524, or P17B.
            
            OUTPUT FORMAT:
            Just list them line by line like this:
            SERIAL | MODEL
            
            Example:
            P1250920000034 | Dejavoo P1
            181251934334 | Valor VL550
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text();
        
        const items = [];
        const seenSerials = new Set();

        // --- HARD-CODED PATTERN HARVESTER ---
        // This scans the AI response text directly for specific serial number patterns.
        // Even if the AI's formatting is broken or it includes extra text, we will find these.
        const patterns = [
            { regex: /\b(18125\d{7})\b/g, type: "Valor VL550" },
            { regex: /\b(X5C8[A-Z0-9]{8,10})\b/g, type: "Valor VP800" },
            { regex: /\b(P125\d{10,12})\b/g, type: "Dejavoo P1" },
            { regex: /\b(P325\d{10,12})\b/g, type: "Dejavoo P3" },
            { regex: /\b(P524\d{10,12})\b/g, type: "Dejavoo P5" },
            { regex: /\b(P17[B86]\d{10,12})\b/g, type: "Dejavoo P17" }
        ];

        // Pass 1: Scan for our known prefixes directly in the text
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

        // Pass 2: Line splitting for any missed items (flexible format)
        if (items.length < 5) { // If the specific harvester failed, try a broad split
            const lines = rawText.split('\n');
            lines.forEach(line => {
                if (line.includes('|') || line.includes('-')) {
                    const parts = line.split(/[|-]/);
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
            return sendJsonError(422, "The AI couldn't find any serial numbers. Ensure the PDF is clear and readable.");
        }

        // Return the successfully harvested items
        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("AI Exception:", err);
        // If we get a 404 or specific API error, report it clearly
        const status = err.message?.includes('404') ? 404 : 500;
        const msg = status === 404 ? "The AI model version is currently unavailable for your API key. Try again in a few minutes." : `Processing Error: ${err.message}`;
        return sendJsonError(status, msg);
    }
}
