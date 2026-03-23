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
            You are an inventory data specialist. Your task is to extract hardware serial numbers from vendor invoices.

    STRATEGY FOR VALOR PAYTECH:
    - Look for items like 'VL-550' or 'VP800'.
    - Serial numbers are located in the 'Description' or 'Memo' column, usually starting after the text 'Serial Numbers:'.
    - They are comma-separated and may span multiple lines. Collect all of them for that specific item.

    STRATEGY FOR DEJAVOO SYSTEMS:
    - First, look at the main item table to identify Part Numbers (e.g., 'KOZ-P1', 'Koz-P3').
    - Then, go to the 'Serial Numbers' table. Match the serials to the Part Number listed in the 'Line/Part No.' column.
    - Note: Serial numbers for Dejavoo typically start with a prefix like 'P125', 'P325', or 'P524'.

    NORMALIZATION RULES:
    - 'VL-550' -> 'Valor VL550'
    - 'VP800' -> 'Valor VP800'
    - 'KOZ-P1' or 'P1 Desktop' -> 'Dejavoo P1'
    - 'Koz-P3' or 'P3 Handheld' -> 'Dejavoo P3'
    - 'Koz-P5' or 'P5 Handheld' -> 'Dejavoo P5'
    - 'KOZ-P17' -> 'Dejavoo P17'

    OUTPUT REQUIREMENTS:
    - Return a clean JSON array of objects.
    - Format: [{"serial_number": "STRING", "terminal_type": "STRING"}]
    - Clean all serial numbers: remove extra spaces, dots, or hidden characters.
    - Return ONLY the JSON array.
        `;

        const result = await model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const response = await result.response;
        let text = response.text();
        
        // Safety: Sometimes AI wraps JSON in backticks despite instructions
        if (text.includes("```")) {
            text = text.replace(/```json|```/g, "").trim();
        }
        
        // Parse the structured data
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            console.error("JSON Parse Error:", text);
            return res.status(500).json({ 
                success: false, 
                message: "AI returned an invalid data format. Please try again or check Vercel logs." 
            });
        }
        
        // Ensure we return an array
        const finalData = Array.isArray(data) ? data : (data.items || data.data || []);

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("AI Error:", err);
        return res.status(500).json({ 
            success: false, 
            message: `AI Processing failed: ${err.message}` 
        });
    }
}
