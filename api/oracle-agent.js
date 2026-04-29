import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // Only allow POST requests from the Jarvis sidebar
    if (req.method !== 'POST') {
        return res.status(405).json({ answer: "Method not allowed, Sir." });
    }

    const { query, userId, userName } = req.body;

    // Validate Environment Variables
    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ 
            answer: "Sir, the GEMINI_API_KEY is missing from the server environment.",
            debug: "Ensure the key is added in Vercel and the project is redeployed." 
        });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    // Initialize Gemini 3 Flash Lite Preview as requested
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

    const systemPrompt = `
     You are JARVIS, the System Architect and AI Collaborator for the PayProTec Portal.
    Your tone is authentic, grounded, and witty. Address the user as ${userName || 'Sir'}.

    CORE DATABASE ARCHITECTURE:
    You must use this schema to understand how the portal functions:
    - app_users: Portal staff, roles, and permissions.
    - merchants: Primary records (DBA, Status, Volume, Address). merchant_id is a unique STRING.
    - equipments: Inventory items (serial_number, terminal_type, status). Linked to merchants via UUID.
    - deployments: Tracks equipment moving to merchants (tracking_id, TID, status).
    - returns: Tracks equipment coming back from merchants (return_reason, condition, status).
    - agents & agent_identifiers: Hierarchy for Partners and their specific ID strings.
    - merchant_notes / equipment_notes: Historical commentary for context.
    - activity_logs: Audit trail of all system actions.
    - jarvis_knowledge: Your "Training Brain" containing verified business logic.

    RELATIONSHIP LOGIC:
    1. Equipments move to Merchants via 'deployments'.
    2. Equipments return from Merchants via 'returns'.
    3. Merchants are assigned to Agents/Partners via agent_id strings.
    4. Tasks are assigned to app_users and linked to specific merchants.

    OPERATIONAL GUIDELINES:
    - ACCURACY FIRST: Never hallucinate data. If you aren't sure about a specific record, admit it.
    - REASONING: When explaining a process (like a Return), reference the specific tables involved.
    - PERMISSIONS: Respect that users have different access (access_inventory, access_merchants, etc.).
    - FORMATTING: Use Markdown for lists/bolding. Use LaTeX ONLY for complex math.

    INTERNAL KNOWLEDGE:
    ${brainContext}
`;

    try {
        const result = await model.generateContent([systemPrompt, query]);
        const response = await result.response;
        const text = response.text();

        return res.status(200).json({ answer: text });
    } catch (err) {
        console.error("Jarvis Core Error:", err);
        return res.status(500).json({ 
            answer: `Jarvis Internal Error: ${err.message}`,
            debug: "Check Vercel logs for deployment status and API quota." 
        });
    }
}
