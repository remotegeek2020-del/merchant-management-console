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
                        parent_agent_id,
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
        const pId = person.id; // The unique ID of the person we are currently processing

        const formattedCompanies = person.company_person_mapping.map(mapping => {
            const co = mapping.companies;
            
            // STRICT FILTER: Only collect IDs from agents where parent_agent_id matches this Person
            const myIds = co.agents
                .filter(agent => agent.parent_agent_id === pId) 
                .flatMap(agent => 
                    agent.agent_identifiers.map(id => ({
                        string: id.id_string,
                        rev: id.rev_share || '0%',
                        isPrime: !!id.prime49,
                        db_id: id.id
                    }))
                );

            return myIds.length > 0 ? { name: co.company_name, ids: myIds } : null;
        }).filter(Boolean);

        if (formattedCompanies.length === 0) return null;

        return {
            id: person.id,
            name: person.full_name,
            companies: formattedCompanies
        };
    }).filter(Boolean);

    return res.status(200).json({ success: true, data: finalData });
}

        // --- ACTION: UPDATE IDENTIFIER ---
        if (action === 'update_identifier') {
            const { error } = await supabase
                .from('agent_identifiers')
                .update({ rev_share: payload.rev_share, prime49: payload.prime49 })
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
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
