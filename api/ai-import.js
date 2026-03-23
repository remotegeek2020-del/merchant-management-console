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
        
        // Use 1.5-flash: It is significantly faster and more reliable on the Free Tier 
        // than the preview models for high-volume extraction.
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
            }
        });

        const prompt = `
            Act as a hardware auditor. Extract EVERY serial number from this PDF.
            
            DIRECTIONS:
            1. VALOR: Extract 12-digit strings from comma-separated lists in Memo columns.
            2. DEJAVOO: Match serials (P125..., P325..., P17B...) to model names using table indices.
            
            MAPPING:
            "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            
            OUTPUT:
            Return a JSON array: [{"serial_number": "...", "terminal_type": "..."}]
            If there are many, extract as many as you can before the limit.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- FREE TIER "JSON HEALER" ---
        
        // Find the start of the array
        const start = text.indexOf('[');
        if (start === -1) return sendJsonError(422, "No list found in document.");

        let jsonString = text.substring(start);

        // If the array didn't close (common on Free Tier timeouts), we surgically close it.
        if (!jsonString.includes(']')) {
            const lastClosingBrace = jsonString.lastIndexOf('}');
            if (lastClosingBrace !== -1) {
                jsonString = jsonString.substring(0, lastClosingBrace + 1) + ']';
            }
        } else {
            // Clean up everything after the closing bracket
            const end = jsonString.lastIndexOf(']');
            jsonString = jsonString.substring(0, end + 1);
        }

        try {
            const data = JSON.parse(jsonString);
            const finalData = Array.isArray(data) ? data : [];
            
            if (finalData.length === 0) {
                return sendJsonError(422, "Scanned, but found no serial numbers.");
            }

            // Cleanup strings
            const cleanedData = finalData.map(item => ({
                serial_number: String(item.serial_number || "").replace(/[.,\s]/g, ""),
                terminal_type: item.terminal_type || "Terminal"
            })).filter(item => item.serial_number.length > 5);

            return res.status(200).json({ success: true, data: cleanedData });
        } catch (parseErr) {
            // Final Regex Rescue for Free Tier
            const items = [];
            const regex = /\{\s*"serial_number"\s*:\s*"([^"]+)"\s*,\s*"terminal_type"\s*:\s*"([^"]+)"\s*\}/g;
            let match;
            while ((match = regex.exec(jsonString)) !== null) {
                items.push({
                    serial_number: match[1].replace(/[.,\s]/g, ""),
                    terminal_type: match[2]
                });
            }

            if (items.length > 0) return res.status(200).json({ success: true, data: items });
            return sendJsonError(500, "The invoice is too complex. Try splitting the PDF into separate pages.");
        }

    } catch (err) {
        console.error("Gemini Error:", err);
        return sendJsonError(500, `AI Error: ${err.message}`);
    }
}
