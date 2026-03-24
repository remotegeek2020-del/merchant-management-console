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
     // --- ACTION: GET PARTNERS LIST (Surgical Fix for "persons_1" error) ---
if (action === 'get_partners_list') {
    const { data, error } = await supabase
        .from('persons')
        .select(`
            id,
            first_name,
            last_name,
            company_person_mapping (
                companies (
                    id, 
                    company_name,
                    agents (
                        id,
                        agent_identifiers (id_string)
                    )
                )
            )
        `);

    if (error) {
        console.error("Supabase Query Error:", error);
        throw error;
    }

    // Process the data to group by Person
    const rollup = data.map(person => {
        return {
            id: person.id,
            name: `${person.first_name || ''} ${person.last_name || ''}`.trim(),
            // Extract companies from the mapping
            companies: person.company_person_mapping?.map(m => {
                const co = m.companies;
                return {
                    id: co?.id,
                    name: co?.company_name || 'Unknown Company',
                    // Flatten IDs from all agents under this company
                    ids: co?.agents?.flatMap(a => 
                        a.agent_identifiers?.map(ai => ai.id_string)
                    ) || []
                };
            }).filter(c => c.id) || [] // Remove any null mappings
        };
    });

    return res.status(200).json({ 
        success: true, 
        data: rollup 
    });
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
