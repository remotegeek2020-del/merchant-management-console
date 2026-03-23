import { GoogleGenerativeAI } from "@google/generative-ai";

// Vercel config to increase body size limit for large PDF base64 strings
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

export default async function handler(req, res) {
    // Ensure the response is always JSON even for early exits
    const sendError = (status, message) => {
        return res.status(status).json({ success: false, message });
    };

    // Only allow POST requests
    if (req.method !== 'POST') {
        return sendError(405, 'Method Not Allowed');
    }

    // 1. Check for API Key
    if (!process.env.GEMINI_API_KEY) {
        return sendError(500, 'Server Configuration Error: GEMINI_API_KEY is missing.');
    }

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) {
            return sendError(400, 'No file data received.');
        }

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Define a strict schema to force the output format
        const responseSchema = {
            type: "array",
            items: {
                type: "object",
                properties: {
                    serial_number: { type: "string" },
                    terminal_type: { type: "string" }
                },
                required: ["serial_number", "terminal_type"]
            }
        };

        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: { 
                responseMimeType: "application/json",
                responseSchema: responseSchema,
                temperature: 0.1 // Lower temperature for more consistent data extraction
            }
        });

        const prompt = `
            You are a professional hardware inventory auditor.
            TASK: Extract all hardware serial numbers and their corresponding model types from this invoice PDF.
            
            INSTRUCTIONS:
            1. Scan the document for "Serial Numbers" lists.
            2. Match each serial number to the "Item", "Model", or "Part Number" mentioned nearby.
            3. Clean serial numbers: Remove spaces, dots, or hidden characters.
            
            VENDOR SPECIFIC LOGIC:
            - VALOR: Serials are usually in a comma-separated list inside the 'Description' or 'Memo' column.
            - DEJAVOO: Serials are in a separate 'Serial Numbers' table at the end of the document.
            
            MAPPING RULES:
            - 'VL-550', 'VP800' -> 'Valor VL550' or 'Valor VP800'
            - 'KOZ-P1', 'Koz-P3', 'Koz-P5' -> 'Dejavoo P1', 'Dejavoo P3', 'Dejavoo P5'
            
            OUTPUT:
            Return ONLY a raw JSON array of objects. 
            Example: [{"serial_number": "181251934334", "terminal_type": "Valor VL550"}]
        `;

        // Send to Gemini
        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text();
        
        // Safety: Sometimes AI wraps JSON in backticks despite instructions
        if (text.includes("```")) {
            text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        }
        
        // Fallback: If JSON.parse fails, try to find the array using Regex
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            console.log("Standard parse failed, trying regex fallback...");
            const jsonMatch = text.match(/\[\s*\{.*\}\s*\]/s);
            if (jsonMatch) {
                data = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error("AI output was not valid JSON");
            }
        }
        
        // Ensure we return an array even if nested
        const finalData = Array.isArray(data) ? data : (data.items || data.data || data.equipment || []);

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendError(500, `AI Processing failed: ${err.message}`);
    }
}
