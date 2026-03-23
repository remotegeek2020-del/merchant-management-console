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
                responseSchema: responseSchema
            }
        });

        const prompt = `
            Extract all hardware serial numbers from this invoice. 
            Return an array of objects.

            RULES:
            - Valor (VL-550, VP800) -> 'Valor VL550' or 'Valor VP800'
            - Dejavoo (KOZ-P1, Koz-P3, Koz-P5) -> 'Dejavoo P1', 'Dejavoo P3', 'Dejavoo P5'
            - Look for serials in descriptions (Valor) or the 'Serial Numbers' table (Dejavoo).
            - Ensure every single serial number is captured.
            - Clean the data: remove dots, spaces, or commas from the serial strings.
            - Output ONLY a raw JSON array.
        `;

        // Send to Gemini
        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text();
        
        // Safety: Clean Markdown code blocks if the AI ignored the JSON mode settings
        if (text.includes("```")) {
            text = text.replace(/```json/g, "").replace(/```/g, "").trim();
        }
        
        // Parse the structured data
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            console.error("JSON Parse Error. Raw Text:", text);
            return sendError(500, "AI returned invalid JSON. Please check Vercel logs.");
        }
        
        // Ensure we return an array even if nested
        const finalData = Array.isArray(data) ? data : (data.items || data.data || data.equipment || []);

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendError(500, `AI Processing failed: ${err.message}`);
    }
}
