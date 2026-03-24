import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    
    const supabase = createClient(
        process.env.SUPABASE_URL, 
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const body = req.body || {};
    const { action, person_id, query } = body;

    try {
 // --- ACTION: GET PARTNERS LIST (Aliased Fix) ---
if (action === 'get_partners_list') {
    // We are selecting from 'persons' but being extremely explicit
    const { data, error } = await supabase
        .from('persons')
        .select(`
            id,
            firstName:first_name, 
            lastName:last_name,
            company_person_mapping (
                companies (
                    id, 
                    companyName:company_name,
                    agents (
                        id,
                        agent_identifiers (id_string)
                    )
                )
            )
        `);

    if (error) {
        // If it fails again, this log will tell us EXACTLY which column it hates
        console.error("Database Error Detail:", error);
        return res.status(500).json({ success: false, message: error.message });
    }

    const rollup = data.map(p => ({
        id: p.id,
        // Using the aliases we created above (firstName / lastName)
        name: `${p.firstName || ''} ${p.lastName || ''}`.trim() || 'Unnamed Partner',
        companies: p.company_person_mapping?.map(m => {
            const co = m.companies;
            if (!co) return null;
            return {
                id: co.id,
                name: co.companyName || 'Unknown Entity',
                ids: co.agents?.flatMap(a => 
                    a.agent_identifiers?.map(ai => ai.id_string)
                ) || []
            };
        }).filter(Boolean) || []
    }));

    return res.status(200).json({ success: true, data: rollup });
}
        // --- ACTION: GET SUB-AGENTS (For the Hierarchy Tab) ---
        if (action === 'get_hierarchy') {
            // 1. First, find all Agent UUIDs owned by this person
            const { data: myAgents } = await supabase
                .from('agents')
                .select('id')
                .in('company_id', supabase
                    .from('company_person_mapping')
                    .select('company_id')
                    .eq('person_id', person_id)
                );

            const myAgentIds = myAgents.map(a => a.id);

            // 2. Find any agents where the parent_agent_id is in Michelle's list
            const { data: subs, error: subError } = await supabase
                .from('agents')
                .select(`
                    id, 
                    agent_name, 
                    parent_agent_id,
                    agent_identifiers (id_string)
                `)
                .in('parent_agent_id', myAgentIds);

            if (subError) throw subError;
            return res.status(200).json({ success: true, data: subs });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error("Partner API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
