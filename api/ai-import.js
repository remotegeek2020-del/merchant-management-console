import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    // 1. Check for API Key
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ 
            success: false, 
            message: 'Server Error: GEMINI_API_KEY is missing in Vercel settings.' 
        });
    }

    try {
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

        const { fileBase64 } = req.body;
        if (!fileBase64) {
            return res.status(400).json({ success: false, message: 'No file data received.' });
        }

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

        // We use the simpler generateContent call with inlineData
        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text();
        
        // Safety: Clean Markdown code blocks if the AI ignored the JSON mode
        if (text.includes("```")) {
            text = text.replace(/```json/g, "")
                       .replace(/```/g, "")
                       .trim();
        }
        
        // Parse the structured data
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            console.error("JSON Parse Error. Raw Text:", text);
            return res.status(500).json({ 
                success: false, 
                message: "AI returned an unparseable format. Please check Vercel Logs for the raw output." 
            });
        }
        
        // Ensure we return an array even if it's nested
        const finalData = Array.isArray(data) ? data : (data.items || data.data || data.equipment || []);

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("AI Error:", err);
        return res.status(500).json({ 
            success: false, 
            message: `AI Processing failed: ${err.message}` 
        });
    }
}
