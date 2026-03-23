import { GoogleGenerativeAI } from "@google/generative-ai";

// Vercel config to allow large base64 uploads
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
        
        // Use 1.5-flash for maximum speed and stability on high-volume lists
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
            }
        });

        // We are NOT using responseMimeType: "application/json" here.
        // On free tier with 170+ items, the JSON often breaks.
        // Instead, we ask for a very specific text format we can parse manually.
        const prompt = `
            Act as a precise data extraction engine. 
            Extract EVERY hardware serial number from the attached invoice.
            
            VENDOR PATTERNS:
            1. VALOR PAYTECH: Extract 12-digit strings from comma-separated lists in Memo/Description.
            2. DEJAVOO SYSTEMS: Match serials (P125..., P325..., P524..., P17B...) to model names using the Line No. index (1:KOZ-P1, 2:Koz-P3, etc).
            
            MAPPING:
            - Normalize to: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            
            OUTPUT INSTRUCTIONS:
            Return the data as a list of JSON objects, one per line, like this:
            {"sn": "SERIAL1", "type": "MODEL1"}
            {"sn": "SERIAL2", "type": "MODEL2"}
            
            DO NOT wrap this in a top-level array or object. Just one JSON object per line.
            Extract as many as you can before reaching the limit.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        const rawText = response.text().trim();
        
        // --- STREAM-RESILIENT PARSER ---
        // This splits the response by line and attempts to parse each line individually.
        // If a line is cut off mid-way, it simply skips it but keeps all the successful ones.
        const lines = rawText.split('\n');
        const finalItems = [];

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            
            // Clean markdown code blocks if AI added them
            if (line.includes('```')) continue;

            try {
                // Find the first { and last } in the line to handle potential noise
                const start = line.indexOf('{');
                const end = line.lastIndexOf('}');
                if (start !== -1 && end !== -1) {
                    const obj = JSON.parse(line.substring(start, end + 1));
                    if (obj.sn || obj.serial_number) {
                        finalItems.push({
                            serial_number: String(obj.sn || obj.serial_number || "").replace(/[.,\s]/g, ""),
                            terminal_type: obj.type || obj.terminal_type || "Terminal"
                        });
                    }
                }
            } catch (e) {
                // If a line fails (common for the very last truncated line), we just keep going
                console.warn("Skipping malformed line in stream extraction");
            }
        }

        // --- NUCLEAR FALLBACK: If the line-by-line failed, try a global regex search ---
        if (finalItems.length === 0) {
            const snRegex = /"sn"\s*:\s*"([^"]+)"\s*,\s*"type"\s*:\s*"([^"]+)"/g;
            let match;
            while ((match = snRegex.exec(rawText)) !== null) {
                finalItems.push({
                    serial_number: match[1].replace(/[.,\s]/g, ""),
                    terminal_type: match[2]
                });
            }
        }

        if (finalItems.length === 0) {
            return sendJsonError(422, "No serial numbers were identified. Ensure the PDF has selectable text.");
        }

        return res.status(200).json({ success: true, data: finalItems });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI Processing failed: ${err.message}`);
    }
}
