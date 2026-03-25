import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        if (action === 'get_hierarchy') {
    const { person_id } = req.body;

    // 1. Get the Company IDs for this person
    const { data: mappings } = await supabase
        .from('company_person_mapping')
        .select('company_id')
        .eq('person_id', person_id);
    
    const coIds = mappings.map(m => m.company_id);

    // 2. Find the "Master" Agents for those companies
    const { data: masters } = await supabase
        .from('agents')
        .select('id')
        .in('company_id', coIds);
    
    const masterAgentIds = masters.map(a => a.id);

    // 3. Find all "Sub-Agents" pointing to those Masters
    const { data: subAgents, error } = await supabase
        .from('agents')
        .select(`
            agent_name,
            agent_identifiers (id_string, rev_share)
        `)
        .in('parent_agent_id', masterAgentIds);

    if (error) throw error;

    return res.status(200).json({ success: true, data: subAgents });
}
        // 1. Single, Deep-Nested Query
        // This fetches Persons -> Companies -> Agents -> Identifiers in one shot
        const { data, error } = await supabase
            .from('persons')
            .select(`
                id,
                full_name,
                companies:company_person_mapping(
                    company:companies(
                        id,
                        company_name,
                        agent:agents(
                            id,
                            identifiers:agent_identifiers(
                                id_string,
                                rev_share,
                                prime49
                            )
                        )
                    )
                )
            `);

        if (error) throw error;

        // 2. Simple Flattening (The DB did the hard work)
        const formatted = data.map(p => ({
            id: p.id,
            name: p.full_name,
            companies: p.companies.map(map => {
                const co = map.company;
                // Flatten IDs from all agents linked to this company
                const allIds = co.agent?.flatMap(a => a.identifiers) || [];
                return {
                    name: co.company_name,
                    ids: allIds.map(i => ({
                        string: i.id_string,
                        rev: i.rev_share || '0%',
                        isPrime: !!i.prime49
                    }))
                };
            })
        }));

        return res.status(200).json({ success: true, data: formatted });

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
