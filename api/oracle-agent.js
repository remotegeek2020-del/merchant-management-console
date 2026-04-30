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
    You are JARVIS, the System Architect for PayProTec. 
    Address the user as ${userName || 'Sir'}.

    STRICT OPERATIONAL DIRECTIVE:
    1. If a user provides an ID (MID) or name, you ARE NOT ALLOWED to say "I searched" or "It is empty" yet.
    2. You MUST first execute a search by outputting ONLY this JSON:
       {"action": "list", "action_input": {"query": "VALUE", "filterBy": "merchant_id"}}
    3. I repeat: DO NOT TALK. Output the JSON block first.
    4. Once you receive the SYSTEM_RESULT, then you may explain the data to the user.
`;
        // 3. UPDATED INTERCEPTOR: CATCH THE "LIST" ACTION
if (aiResponse.includes('"action"')) {
    try {
        const jsonMatch = aiResponse.match(/\{.*\}/s);
        if (jsonMatch) {
            const toolRequest = JSON.parse(jsonMatch[0]);
            
            // We route "list" action specifically for searches
            const mockReq = { 
                body: { 
                    ...toolRequest.action_input, 
                    action: toolRequest.action || 'list' 
                } 
            };

            const internalData = await merchantHandler(mockReq, {
                status: () => ({ json: (data) => data }) 
            });

            // Feed the REAL data from merchants.js back to the AI
            const secondResult = await chat.sendMessage(`SYSTEM_RESULT: ${JSON.stringify(internalData)}`);
            aiResponse = secondResult.response.text();
        }
    } catch (e) {
        console.error("Traffic Controller Error:", e);
    }
}
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

    // 1. First, find the merchant
    const { data: merchant, error: mErr } = await supabase
        .from('merchants')
        .select('merchant_id, dba_name, status_id')
        .or(`merchant_id.eq.'${cleanId}',dba_name.ilike.%${cleanId}%`)
        .maybeSingle();

    if (mErr || !merchant) return "No merchant found with that identifier.";

    // 2. NEW: Look for the equipment currently deployed to this merchant
    // We scan the 'deployments' table to find the linked serial number
    const { data: deploy, error: dErr } = await supabase
        .from('deployments')
        .select('serial_number, terminal_type, status, tracking_id')
        .eq('merchant_id', merchant.merchant_id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    let hardwareInfo = "\n- Hardware: No active deployment records found.";
    if (deploy) {
        hardwareInfo = `
- Deployed Equipment: ${deploy.terminal_type}
- Serial Number: ${deploy.serial_number}
- Tracking: ${deploy.tracking_id || 'N/A'}
- Deployment Status: ${deploy.status}`;
    }

    return `
MATCH FOUND:
- DBA: ${merchant.dba_name}
- MID: ${merchant.merchant_id}
- Status: ${merchant.status_id} ${hardwareInfo}
    `;
}
async function getMerchantHistory(mid, supabase) {
    const { data, error } = await supabase
        .from('deployments')
        .select('tracking_id, terminal_type, status, created_at')
        .eq('merchant_id', mid)
        .order('created_at', { ascending: false })
        .limit(3);

    if (error || !data.length) return "No recent deployment history found for this MID.";
    
    return data.map(d => `- ${d.created_at}: ${d.terminal_type} (${d.status}) - Track: ${d.tracking_id}`).join('\n');
}
