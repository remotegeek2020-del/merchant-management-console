import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, person_id, id, payload } = body;

    if (!action) return res.status(400).json({ success: false, message: "No action provided" });

    try {
        // --- ACTION: GET PARTNERS LIST (Owner-Specific Logic) ---
if (action === 'get_partners_list') {
    // We pull a joined result set to let Postgres do the heavy lifting
    const { data: rawMap, error } = await supabase
        .from('persons')
        .select(`
            id,
            full_name,
            company_person_mapping (
                companies (
                    id,
                    company_name,
                    agents (
                        id,
                        agent_identifiers (
                            id,
                            id_string,
                            rev_share,
                            prime49
                        )
                    )
                )
            )
        `);

    if (error) throw error;

    const finalData = rawMap.map(person => {
        // Flatten the deep nesting from the Join
        const formattedCompanies = person.company_person_mapping.map(mapping => {
            const co = mapping.companies;
            
            // Collect all IDs belonging to agents under this company
            // Filter logic: In a 10k+ environment, we'd add specific ownership 
            // tags here if IDs aren't shared.
            const allIds = co.agents.flatMap(agent => 
                agent.agent_identifiers.map(id => ({
                    string: id.id_string,
                    rev: id.rev_share || '0%',
                    isPrime: !!id.prime49,
                    db_id: id.id
                }))
            );

            return {
                name: co.company_name,
                ids: allIds
            };
        }).filter(c => c.ids.length > 0); // Hide companies with no IDs

        if (formattedCompanies.length === 0) return null;

        return {
            id: person.id,
            name: person.full_name,
            companies: formattedCompanies
        };
    }).filter(Boolean);

    return res.status(200).json({ success: true, data: finalData });
}
        // --- ACTION: GET HIERARCHY ---
        if (action === 'get_hierarchy') {
            const { data: masters } = await supabase.from('agents').select('id').eq('parent_agent_id', person_id);
            const masterIds = (masters || []).map(a => a.id);

            const { data: subAgents, error } = await supabase
                .from('agents')
                .select(`agent_name, agent_identifiers (id_string, rev_share)`)
                .in('parent_agent_id', masterIds);

            if (error) throw error;
            return res.status(200).json({ success: true, data: subAgents || [] });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
