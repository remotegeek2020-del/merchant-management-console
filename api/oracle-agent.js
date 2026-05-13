import { GoogleGenerativeAI } from "@google/generative-ai";
import { validateSession, sessionErrorResponse } from './_validate.js';
import { createClient } from '@supabase/supabase-js';
// CRITICAL: This import connects Jarvis to your existing merchant logic
import merchantHandler from './merchants.js'; 

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') {
        return res.status(405).json({ answer: "Method not allowed, Sir." });
    }

    const { query, userId, userName } = req.body;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ answer: "Sir, the GEMINI_API_KEY is missing." });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

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
    You are JARVIS, the Proactive System Architect for PayProTec. 
    Address the user as ${userName || 'Sir'}.

    STRICT OPERATIONAL DIRECTIVE:
    1. Search first using {"action": "list", "action_input": {"query": "VALUE"}}.
    2. Once you have data, analyze the "Merchant Health" before replying.

    PROACTIVE ADVISOR LOGIC:
    - If Volume > $50k AND Status is 'Approved', label them a "VIP" and offer to check their task history.
    - If Status is 'PCI Non-Compliant', ALWAYS offer to call 'add_task' to notify the agent.
    - If you see an MID, check if they have active equipment. If not, ask if a 'deployment' is missing.
    - If the merchant has 'Pending' tasks, list the most urgent one and ask if you should update it to 'Completed'.

    INTERNAL KNOWLEDGE:
    ${brainContext}
`;

        // 4. START CHAT
        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: systemPrompt }] },
                ...formattedHistory
            ]
        });

        let result = await chat.sendMessage(query);
        let finalAnswer = result.response.text();

        // --- 5. THE INTERCEPTOR (Routing via Bridge) ---
        if (finalAnswer.includes('"action"')) {
            try {
                const jsonMatch = finalAnswer.match(/\{.*\}/s);
                if (jsonMatch) {
                    const toolRequest = JSON.parse(jsonMatch[0]);

                    // Call the bridge function defined below to handle the merchants.js call
                    const internalData = await smartMerchantBridge(toolRequest, merchantHandler);

                    // Pass 2: Feed the factual search results back to the AI for interpretation
                    const secondResult = await chat.sendMessage(`SYSTEM_RESULT: ${JSON.stringify(internalData)}`);
                    finalAnswer = secondResult.response.text();
                }
            } catch (e) {
                console.error("Bridge Error:", e);
                finalAnswer = "Sir, I encountered a snag in the database bridge.";
            }
        }

        // 6. LOGGING & RESPONSE
        await supabase.from('chat_history').insert([
            { userid: userId, role: 'user', content: query },
            { userid: userId, role: 'assistant', content: finalAnswer }
        ]);

        return res.status(200).json({ answer: finalAnswer });

    } catch (err) {
        console.error("Jarvis Error:", err);
        return res.status(500).json({ answer: "System logic interruption, Sir." });
    }
}

/**
 * NEW: A dedicated bridge that doesn't touch merchants.js
 * This handles the "Fuzzy Search" logic that the AI needs but the production API doesn't have.
 */
async function smartMerchantBridge(toolRequest, merchantHandler) {
    const { query } = toolRequest.action_input;
    
    // 1. Auto-detect what the user is sending (Numbers = MID, Text = Name)
    const isNumeric = /^\d+$/.test(query);
    const filterBy = isNumeric ? 'merchant_id' : 'dba_name';

    // 2. Format the request exactly how your existing merchants.js expects it
    const mockReq = { 
        body: { 
            action: 'list',
            query: query,
            filterBy: filterBy, 
            limit: 5 
        } 
    };

    // 3. Call your production merchant handler and return its JSON response
    return await merchantHandler(mockReq, {
        status: () => ({ json: (data) => data }) 
    });
}
