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
            - merchants: Primary records (DBA, Status, Volume, Address). merchant_id is a unique STRING.
            - equipments: Inventory items (serial_number, terminal_type, status). Linked to merchants via UUID.
            - deployments: Tracks equipment moving to merchants (tracking_id, TID, status).
            - returns: Tracks equipment coming back from merchants (return_reason, condition, status).
            - agents & agent_identifiers: Hierarchy for Partners and their specific ID strings.
            - merchant_notes / equipment_notes: Historical commentary.
            - activity_logs: Audit trail of all system actions.
            - jarvis_knowledge: Your "Training Brain" containing verified business logic.

            RELATIONSHIP LOGIC:
            1. Equipments move to Merchants via 'deployments'.
            2. Equipments return from Merchants via 'returns'.
            3. Merchants are assigned to Agents/Partners via agent_id strings.
            4. Tasks are assigned to app_users and linked to specific merchants.

            INTERNAL KNOWLEDGE:
            ${brainContext}

            OPERATIONAL GUIDELINES:
            - ACCURACY FIRST: Never hallucinate data. Reference the specific tables above.
            - PERMISSIONS: Respect access_inventory, access_merchants, etc.
            - FORMATTING: Use Markdown. Use LaTeX ONLY for complex math.
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
