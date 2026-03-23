import { GoogleGenerativeAI } from "@google/generative-ai";

// Vercel config to allow large base64 uploads from multi-page PDFs
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
        
        // We use the most advanced model available.
        // We are removing responseMimeType to allow the model to use its full reasoning 
        // capacity without being "choked" by strict JSON token constraints on large lists.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025",
            generationConfig: {
                temperature: 0.1,
            }
        });

        const prompt = `
            Act as a high-precision hardware inventory auditor.
            TASK: Extract EVERY hardware serial number from this PDF.
            
            VENDOR PATTERNS TO MATCH:
            1. VALOR: Look for long strings of numbers (12 digits) often separated by commas.
            2. DEJAVOO: Look for serials in the table at the end (often starting with P12, P32, P52, P17).
            
            MAPPING RULES:
            - If item is VL-550/VL550 or VP800 -> "Valor VL550" or "Valor VP800"
            - If item is KOZ-P1, Koz-P3, Koz-P5, KOZ-P17 -> "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17"
            
            OUTPUT:
            Return a JSON array of objects: [{"serial_number": "...", "terminal_type": "..."}]
            Capture EVERY SINGLE serial number found across all pages. 
            If there are 170 serials, I expect 170 objects.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- MULTI-LAYER RECOVERY PARSER ---
        
        let finalData = [];

        // Layer 1: Standard JSON Parse
        try {
            // Clean markdown blocks
            let cleanText = text.replace(/```json/g, "").replace(/```/g, "").trim();
            const start = cleanText.indexOf('[');
            const end = cleanText.lastIndexOf(']');
            
            if (start !== -1 && end !== -1) {
                let jsonString = cleanText.substring(start, end + 1);
                
                // Attempt to heal truncated JSON if necessary
                if (!jsonString.endsWith(']')) {
                    const lastBrace = jsonString.lastIndexOf('}');
                    if (lastBrace !== -1) jsonString = jsonString.substring(0, lastBrace + 1) + ']';
                }
                
                const parsed = JSON.parse(jsonString);
                if (Array.isArray(parsed)) finalData = parsed;
            }
        } catch (e) {
            console.warn("JSON Parse failed, falling back to Pattern Matching...");
        }

        // Layer 2: Pattern Matching Fallback (In case AI returned mixed text or broken JSON)
        if (finalData.length === 0) {
            // Look for patterns like {"serial_number": "...", "terminal_type": "..."}
            const regex = /\{\s*"serial_number"\s*:\s*"([^"]+)"\s*,\s*"terminal_type"\s*:\s*"([^"]+)"\s*\}/g;
            let match;
            while ((match = regex.exec(text)) !== null) {
                finalData.push({
                    serial_number: match[1].replace(/[.,\s]/g, ""),
                    terminal_type: match[2]
                });
            }
        }

        // Layer 3: Raw Serial Extraction (The "Nuclear" option)
        if (finalData.length === 0) {
            // Match any 10-15 digit alphanumeric string that looks like a serial
            const serialRegex = /\b[A-Z0-9]{10,16}\b/g;
            const foundSerials = text.match(serialRegex) || [];
            
            // Try to guess type based on document keywords
            let guessedType = "Unknown Terminal";
            if (text.toLowerCase().includes("valor")) guessedType = "Valor VL550";
            if (text.toLowerCase().includes("dejavoo")) guessedType = "Dejavoo P1";

            finalData = foundSerials.map(s => ({
                serial_number: s,
                terminal_type: guessedType
            }));
        }

        if (finalData.length === 0) {
            return sendJsonError(422, "The AI couldn't find a valid list. Please ensure the PDF has selectable text.");
        }

        // Final cleanup of the data
        finalData = finalData.map(item => ({
            serial_number: String(item.serial_number).replace(/[.,\s]/g, ""),
            terminal_type: item.terminal_type || "Unknown Terminal"
        }));

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("AI System Error:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
