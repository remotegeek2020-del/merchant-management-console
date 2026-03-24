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
        // --- ACTION: GET PARTNERS LIST (For the Grid View) ---
        if (action === 'get_partners_list') {
            const { data, error } = await supabase
                .from('company_person_mapping')
                .select(`
                    person_id,
                    persons:person_id (id, first_name, last_name),
                    companies:company_id (
                        id, 
                        company_name,
                        agents (
                            id,
                            agent_name,
                            agent_identifiers (id_string, status)
                        )
                    )
                `);

            if (error) throw error;

            // We need to group this by Person since the mapping returns one row per company
            const rollup = data.reduce((acc, curr) => {
                const pId = curr.person_id;
                if (!acc[pId]) {
                    acc[pId] = {
                        id: pId,
                        name: `${curr.persons.first_name} ${curr.persons.last_name}`,
                        companies: []
                    };
                }
                
                // Nest the IDs into the company object
                const companyData = {
                    id: curr.companies.id,
                    name: curr.companies.company_name,
                    ids: curr.companies.agents?.flatMap(a => 
                        a.agent_identifiers?.map(ai => ai.id_string)
                    ) || []
                };
                
                acc[pId].companies.push(companyData);
                return acc;
            }, {});

            return res.status(200).json({ 
                success: true, 
                data: Object.values(rollup) 
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
