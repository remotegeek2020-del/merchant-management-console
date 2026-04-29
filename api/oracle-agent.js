import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

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
    // Using Flash for speed and intelligence
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

    try {
        // 1. FETCH INTERNAL KNOWLEDGE (BRAIN)
        const { data: knowledge } = await supabase
            .from('jarvis_knowledge')
            .select('topic, correct_logic')
            .or(`topic.ilike.%${query}%`) 
            .limit(5);

        const brainContext = knowledge?.length > 0 
            ? knowledge.map(k => `Fact on ${k.topic}: ${k.correct_logic}`).join('\n')
            : "No specific internal rules found.";

        // 2. FETCH CHAT HISTORY (MEMORY)
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
            You are JARVIS, System Architect for PayProTec. 
            Tone: Authentic, grounded, witty. Address user as ${userName || 'Sir'}.

            STRICT OPERATIONAL DIRECTIVE:
            1. If asked about a merchant, MID, or owner, you MUST use the search tool.
            2. To search, output EXACTLY this JSON and NOTHING ELSE:
               {"action": "getMerchantIntelligence", "action_input": {"identifier": "VALUE_HERE"}}
            3. Once you get the result, interpret it for the user. NEVER make up data.

            INTERNAL KNOWLEDGE:
            ${brainContext}
        `;

        // 4. GENERATE CONTENT (Pass 1: Reasoning)
        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: systemPrompt }] },
                ...formattedHistory
            ]
        });

        let result = await chat.sendMessage(query);
        let finalAnswer = result.response.text();

        // --- 5. THE INTERCEPTOR (The Bridge to Supabase) ---
        if (finalAnswer.includes('getMerchantIntelligence')) {
            try {
                const jsonMatch = finalAnswer.match(/\{.*\}/s);
                if (jsonMatch) {
                    const toolRequest = JSON.parse(jsonMatch[0]);
                    const id = toolRequest.action_input.identifier;

                    // EXECUTE THE REAL QUERY
                    const realData = await getMerchantIntelligence(id, supabase);

                    // Pass 2: Final factual answer
                    const secondResult = await chat.sendMessage(`SYSTEM_DATABASE_RESULT: ${realData}`);
                    finalAnswer = secondResult.response.text();
                }
            } catch (e) {
                console.error("Tool Error:", e);
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

// Fixed function: Added 'supabase' as a parameter so it can access the client
async function getMerchantIntelligence(identifier, supabase) {
    const cleanId = identifier.toString().trim();

    // STEP 1: Just get the merchant record first (Safe Mode)
    const { data, error } = await supabase
        .from('merchants')
        .select('merchant_id, dba_name, status_id, agent_id') // Try agent_id directly if it exists in merchants
        .or(`merchant_id.eq.'${cleanId}',dba_name.ilike.%${cleanId}%`)
        .maybeSingle();

    if (error) {
        console.error("Supabase Error:", error);
        // We tell the AI EXACTLY what the database said
        return `DATABASE_ERROR: ${error.message} (Hint: Check if merchant_id is the correct column name)`;
    }

    if (!data) return "No record found for that specific ID in the merchants table.";
    
    return `
        MATCH FOUND:
        - DBA: ${data.dba_name}
        - MID: ${data.merchant_id}
        - Status: ${data.status_id}
        - Agent/Owner: ${data.agent_id || 'Refer to Portfolio Table'}
    `;
}
