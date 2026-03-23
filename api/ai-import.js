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
    const sendJsonError = (status, message) => {
        return res.status(status).json({ success: false, message });
    };

    if (req.method !== 'POST') return sendJsonError(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY) return sendJsonError(500, 'API Key Missing');

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return sendJsonError(400, 'No file data received.');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Using the most capable model for high-density document parsing
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-preview-09-2025",
            generationConfig: {
                temperature: 0,
                responseMimeType: "application/json",
            }
        });

        const prompt = `
            Act as a precise hardware inventory auditor. Extract EVERY hardware serial number from the attached PDF.
            
            SPECIFIC VENDOR LOGIC:
            1. DEJAVOO INVOICES: 
               - Look for the "Serial Numbers" table. 
               - It uses an index system like "1:KOZ-P1", "2:Koz-P3", etc. 
               - All serials following index "1" belong to that first part number.
               - Extract every serial number string (e.g., P1250..., P3250..., P5240..., P17B4...).
            
            2. VALOR INVOICES:
               - Look for the "Memo" or "Description" column.
               - Serials are provided as long, comma-separated lists (e.g., 18125...).
               - Extract every 12-digit numeric or alphanumeric string in those blocks.
            
            MAPPING RULES:
            - Normalize types to: "Dejavoo P1", "Dejavoo P3", "Dejavoo P5", "Dejavoo P17", "Valor VL550", "Valor VP800".
            - Clean serials: Strip all periods, spaces, and commas from the serial string.
            
            OUTPUT:
            Return ONLY a JSON array of objects: [{"serial_number": "...", "terminal_type": "..."}]
            It is critical to capture EVERY SINGLE serial number found across ALL pages.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text().trim();
        
        // --- MULTI-LAYER PARSER ---
        
        // 1. Remove Markdown markers if AI ignored instructions
        text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        
        // 2. Find the bounds of the array
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');

        if (start === -1) {
            // Fallback: If it's a JSON object with a key, try to find that
            const objectStart = text.indexOf('{');
            if (objectStart !== -1) {
                try {
                    const obj = JSON.parse(text.substring(objectStart, text.lastIndexOf('}') + 1));
                    const possibleArray = obj.items || obj.data || obj.serials || Object.values(obj).find(val => Array.isArray(val));
                    if (possibleArray) {
                        return res.status(200).json({ success: true, data: possibleArray });
                    }
                } catch (e) { /* continue */ }
            }
            return sendJsonError(422, "The AI could not identify a valid list in this invoice.");
        }

        // 3. JSON HEALING: Force-close truncated lists
        let jsonString = text.substring(start);
        if (!jsonString.includes(']')) {
            const lastClosingBrace = jsonString.lastIndexOf('}');
            if (lastClosingBrace !== -1) {
                jsonString = jsonString.substring(0, lastClosingBrace + 1) + ']';
            }
        } else {
            const finalEnd = jsonString.lastIndexOf(']');
            jsonString = jsonString.substring(0, finalEnd + 1);
        }

        try {
            const data = JSON.parse(jsonString);
            const finalData = Array.isArray(data) ? data : (data.items || data.data || []);
            
            if (finalData.length === 0) {
                return sendJsonError(422, "No serial numbers were found in the document.");
            }

            // Final safety cleanup of strings
            const cleanedData = finalData.map(item => ({
                serial_number: String(item.serial_number || "").replace(/[.,\s]/g, ""),
                terminal_type: item.terminal_type || "Unknown Terminal"
            })).filter(item => item.serial_number.length > 5);

            return res.status(200).json({ success: true, data: cleanedData });
        } catch (parseErr) {
            // Final Regex Search & Rescue
            const items = [];
            const regex = /\{\s*"serial_number"\s*:\s*"([^"]+)"\s*,\s*"terminal_type"\s*:\s*"([^"]+)"\s*\}/g;
            let match;
            while ((match = regex.exec(jsonString)) !== null) {
                items.push({
                    serial_number: match[1].replace(/[.,\s]/g, ""),
                    terminal_type: match[2]
                });
            }

            if (items.length > 0) {
                return res.status(200).json({ success: true, data: items });
            }

            return sendJsonError(500, "The data format is too complex for one scan. Try splitting the PDF.");
        }

    } catch (err) {
        console.error("AI System Error:", err);
        return sendJsonError(500, `AI System Error: ${err.message}`);
    }
}
