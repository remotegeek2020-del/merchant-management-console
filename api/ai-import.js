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
        
        // Use 1.5-flash for maximum speed and stability on free-tier.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0.1,
                // We do NOT use responseMimeType: "application/json" here.
                // Strict JSON mode crashes the entire request if it's truncated.
                // We want the raw text so we can "rescue" partial data.
            }
        });

        const prompt = `
            Act as a precise data extractor. Extract EVERY serial number from this PDF.
            
            DIRECTIONS:
            1. VALOR: Look for 12-digit numeric strings (e.g., 18125...) in Memo columns.
            2. DEJAVOO: Match serials (P125..., P325..., P524..., P17B...) to model names (P1, P3, P5, P17).
            
            NORMALIZED NAMES: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".

            OUTPUT REQUIREMENT (MANDATORY):
            Output each item as a single line of JSON. Do not use a wrapper array.
            Format exactly like this:
            {"sn": "SERIAL_NUMBER", "type": "MODEL_NAME"}
            
            Capture every single number. If the list is long, keep going until you are cut off.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text();
        
        // --- THE RESCUE PARSER ---
        // This splits the response by line and attempts to parse each one.
        // It's "Unbreakable" because if the last line is truncated, it's simply ignored.
        const lines = rawText.split('\n');
        const items = [];
        const seenSerials = new Set();

        for (let line of lines) {
            line = line.trim();
            if (!line || !line.includes('{')) continue;

            try {
                // Find the JSON object within the line
                const start = line.indexOf('{');
                const end = line.lastIndexOf('}');
                if (start !== -1 && end !== -1) {
                    const obj = JSON.parse(line.substring(start, end + 1));
                    const sn = String(obj.sn || obj.serial_number || "").replace(/[.,\s]/g, "").toUpperCase();
                    const type = obj.type || obj.terminal_type || "Terminal";

                    if (sn.length >= 8 && !seenSerials.has(sn)) {
                        items.push({ serial_number: sn, terminal_type: type });
                        seenSerials.add(sn);
                    }
                }
            } catch (e) {
                // Ignore lines that were cut off or malformed
                continue;
            }
        }

        // --- SECONDARY REGEX SCRAPE (IF PARSE YIELDED NOTHING) ---
        if (items.length === 0) {
            const regex = /"sn"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"([^"]+)"/g;
            let match;
            while ((match = regex.exec(rawText)) !== null) {
                const sn = match[1].replace(/[.,\s]/g, "").toUpperCase();
                if (!seenSerials.has(sn)) {
                    items.push({ serial_number: sn, terminal_type: match[2] });
                    seenSerials.add(sn);
                }
            }
        }

        if (items.length === 0) {
            return sendJsonError(422, "The AI couldn't find a list in this format. Try splitting the PDF.");
        }

        return res.status(200).json({ success: true, data: items });

    } catch (err) {
        console.error("Critical AI Error:", err);
        return sendJsonError(500, "The server timed out. Please try uploading just one page of the PDF.");
    }
}
