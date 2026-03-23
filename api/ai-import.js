import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    try {
        const { fileBase64 } = req.body;

        const prompt = `
            Analyze this vendor invoice/packing slip. 
            Extract all equipment into a JSON array. 
            Include: 'serial_number' and 'terminal_type'. 
            If the model is 'P1', label it 'Dejavoo P1'. 
            Return ONLY the JSON array, no extra text.
        `;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);

        const text = result.response.text().replace(/```json|```/g, "").trim();
        const data = JSON.parse(text);

        return res.status(200).json({ success: true, data });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
}
