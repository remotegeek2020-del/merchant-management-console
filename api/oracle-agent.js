import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';
import merchantHandler from './merchants.js'; // Ensure this path is correct

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ answer: "Method not allowed, Sir." });
    }

    const { query, userId, userName } = req.body;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ answer: "Sir, the GEMINI_API_KEY is missing." });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash" });

    try {
        // 1. FETCH INTERNAL KNOWLEDGE
        const { data: knowledge } = await supabase
            .from('jarvis_knowledge')
            .select('topic, correct_logic')
            .or(`topic.ilike.%${query}%`) 
            .limit(5);

        const brainContext = knowledge?.length > 0 
            ? knowledge.map(k => `Fact on ${k.topic}: ${k.correct_logic}`).join('\n')
            : "No specific internal rules found.";

        // 2. FETCH CHAT HISTORY
        const { data: history } = await supabase
            .from('chat_history')
            .select('role, content')
            .eq('userid', userId)
            .order('created_at', { ascending: false })
            .limit(6);

        const formattedHistory = (history || []).map(h => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: h.content }]
        })).reverse();

        // 3. COMPILE SYSTEM PROMPT
        const systemPrompt = `
            You are JARVIS, the System Architect for PayProTec. 
            Address the user as ${userName || 'Sir'}.

            STRICT OPERATIONAL DIRECTIVE:
            1. If a user provides an ID (MID) or name, you MUST first execute a search.
            2. To search, output ONLY this JSON block and stop:
               {"action": "list", "action_input": {"query": "VALUE", "filterBy": "merchant_id"}}
            3. Once you receive the SYSTEM_RESULT, explain the data to the user.

            INTERNAL KNOWLEDGE:
            ${brainContext}
        `;

        // 4. START CHAT & PASS 1 (Reasoning)
        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: systemPrompt }] },
                ...formattedHistory
            ]
        });

        let result = await chat.sendMessage(query);
        let finalAnswer = result.response.text();

        // --- 5. THE INTERCEPTOR (The Bridge to merchants.js) ---
        // We look for any action JARVIS wants to take
        if (finalAnswer.includes('"action"')) {
            try {
                const jsonMatch = finalAnswer.match(/\{.*\}/s);
                if (jsonMatch) {
                    const toolRequest = JSON.parse(jsonMatch[0]);
                    
                    // Route to your existing merchants.js handler
                    const mockReq = { 
                        body: { 
                            ...toolRequest.action_input, 
                            action: toolRequest.action || 'list' 
                        } 
                    };

                    const internalData = await merchantHandler(mockReq, {
                        status: () => ({ json: (data) => data }) 
                    });

                    // Pass 2: Feed real data back to Gemini
                    const secondResult = await chat.sendMessage(`SYSTEM_RESULT: ${JSON.stringify(internalData)}`);
                    finalAnswer = secondResult.response.text();
                }
            } catch (e) {
                console.error("Traffic Controller Error:", e);
            }
        }

        // 6. LOGGING & RESPONSE
        supabase.from('chat_history').insert([
            { userid: userId, role: 'user', content: query },
            { userid: userId, role: 'assistant', content: finalAnswer }
        ]).then(() => {});

        return res.status(200).json({ answer: finalAnswer });

    } catch (err) {
        console.error("Jarvis Error:", err);
        return res.status(500).json({ answer: "System logic interruption, Sir." });
    }
}
