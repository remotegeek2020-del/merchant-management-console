import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ answer: "Method not allowed, Sir." });
    }

    const { query, userId, userName } = req.body;

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ 
            answer: "Sir, the GEMINI_API_KEY is missing from the server environment.",
            debug: "Ensure the key is added in Vercel and the project is redeployed." 
        });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

    try {
        // 1. FETCH INTERNAL KNOWLEDGE (BRAIN)
        const { data: knowledge } = await supabase
            .from('jarvis_knowledge')
            .select('topic, correct_logic')
            .or(`topic.ilike.%${query}%`) // Basic keyword matching for relevance
            .limit(5);

        const brainContext = knowledge?.length > 0 
            ? knowledge.map(k => `Fact on ${k.topic}: ${k.correct_logic}`).join('\n')
            : "No specific internal rules found for this query.";

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
            You are JARVIS, the System Architect and AI Collaborator for the PayProTec Portal.
            Your tone is authentic, grounded, and witty. Address the user as ${userName || 'Sir'}.

            CORE DATABASE ARCHITECTURE:
            - app_users: Portal staff, roles, and permissions.
            - merchants: Primary records (DBA, Status, Volume). merchant_id is a unique STRING.
            - equipments: Inventory items (serial_number, terminal_type).
            - deployments: Outbound equipment to merchants.
            - returns: Inbound equipment from merchants.
            - agents & agent_identifiers: Partner hierarchy.
            - jarvis_knowledge: Your "Training Brain" containing verified business logic from the Secret Dungeon.

            STRICT OPERATIONAL DIRECTIVE:
            1. **VERIFY, DON'T VAMP**: You have access to a tool called 'getMerchantIntelligence'. 
            2. If a user provides a Merchant ID (MID), DBA Name, or Serial Number, you MUST call the appropriate search tool before responding.
            3. NEVER invent data (e.g., "[Redacted Name]" or "Searching..."). If the tool returns no data, say: "Sir, that record does not exist in our central ledger."
            4. Use the Internal Knowledge (Brain Context) below to interpret business rules and "Red Flags" for specific accounts.

            INTERNAL KNOWLEDGE (From Secret Dungeon):
            ${brainContext}

            FORMATTING:
            - Use Markdown for clarity.
            - If a merchant is found, present the data in a clean, professional summary.
        `;

        // 4. GENERATE CONTENT WITH CONTEXT
        const chat = model.startChat({
            history: [
                { role: "user", parts: [{ text: systemPrompt }] },
                ...formattedHistory
            ]
        });

        const result = await chat.sendMessage(query);
        const response = await result.response;
        const finalAnswer = response.text();

        // 5. ASYNC LOGGING (Don't wait for this to finish to respond)
        supabase.from('chat_history').insert([
            { userid: userId, role: 'user', content: query },
            { userid: userId, role: 'assistant', content: finalAnswer }
        ]).then(() => {});

        return res.status(200).json({ answer: finalAnswer });

    } catch (err) {
        console.error("Jarvis Core Error:", err);
        return res.status(500).json({ 
            answer: `Jarvis Internal Error: ${err.message}`,
            debug: "Check Vercel logs for API Key validation." 
        });
    }
}
// This function acts as Jarvis's "eyes" into your 100k merchants
async function getMerchantIntelligence(identifier) {
    const { data, error } = await supabase
        .from('merchants')
        .select(`
            merchant_id, 
            dba_name, 
            status_id,
            merchant_portfolio (
                agent_id,
                commission_tier
            )
        `)
        // This checks if the input is the ID or the Name
        .or(`merchant_id.eq.${identifier},dba_name.ilike.%${identifier}%`)
        .maybeSingle();

    if (error || !data) return "I searched the 100k records but found no match for that identifier.";
    
    return `
        MATCH FOUND:
        - DBA: ${data.dba_name}
        - MID: ${data.merchant_id}
        - Status: ${data.status_id}
        - Owned by Agent: ${data.merchant_portfolio?.agent_id || 'Direct'}
    `;
}
