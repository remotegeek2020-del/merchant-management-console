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
        
        // Use 1.5-flash for maximum speed and stability on free tier
        // We use responseMimeType: "application/json" to force valid data output.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
            }
        });

        const prompt = `
            Extract ALL hardware serial numbers from this PDF.
            
            DIRECTIONS:
            1. VALOR: Extract 12-digit strings (starting with 1812... or X5C...) found in 'Memo' or 'Description'.
            2. DEJAVOO: Extract serials (starting with P125..., P325..., P524..., P17B...) and match them to model names (P1, P3, P5, P17) based on table line indices.
            
            MAPPING:
            Normalize model names to exactly: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            
            OUTPUT:
            Return a JSON object with one key "items" containing an array of objects.
            Format: {"items": [{"serial_number": "...", "terminal_type": "..."}]}
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- ROBUST PARSING ---
        let finalItems = [];

        try {
            // Find JSON content even if wrapped in markdown
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start !== -1 && end !== -1) {
                const parsed = JSON.parse(text.substring(start, end + 1));
                finalItems = parsed.items || (Array.isArray(parsed) ? parsed : []);
            }
        } catch (e) {
            console.warn("JSON Parse failed, falling back to emergency regex scrape.");
        }

        // --- EMERGENCY REGEX SCRAPE ---
        // If JSON failed or is empty, we hunt for the serial patterns directly.
        if (finalItems.length === 0) {
            // Match known serial prefixes: P125, P325, P524, P17B, 1812, X5C
            const serialRegex = /\b(P125|P325|P524|P17B|1812|X5C)[A-Z0-9]{6,12}\b/g;
            const matches = text.match(serialRegex) || [];
            
            // Re-scan the PDF text for the serials if the AI output was too clean
            // (Note: In this specific handler, we only have the AI's response text)
            
            let defaultType = text.toLowerCase().includes("valor") ? "Valor VL550" : "Dejavoo P1";
            
            matches.forEach(s => {
                finalItems.push({
                    serial_number: s,
                    terminal_type: defaultType
                });
            });
        }

        if (finalItems.length === 0) {
            return sendJsonError(422, "No serial numbers identified. Please ensure the PDF is a high-quality digital document.");
        }

        // Final data scrubbing: Remove duplicates and clean strings
        const seen = new Set();
        const cleanedData = finalItems
            .map(item => ({
                serial_number: String(item.serial_number || "").replace(/[.,\s]/g, "").toUpperCase(),
                terminal_type: item.terminal_type || "Terminal"
            }))
            .filter(item => {
                if (item.serial_number.length < 8 || seen.has(item.serial_number)) return false;
                seen.add(item.serial_number);
                return true;
            });

        return res.status(200).json({ success: true, data: cleanedData });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
