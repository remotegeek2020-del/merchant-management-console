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
if (action === 'get_partners_list') {
    // 1. Get all Persons
    const { data: persons, error: pErr } = await supabase
        .from('persons')
        .select('id, first_name, last_name');
    
    if (pErr) throw pErr;

    // 2. Get all Company Mappings with Company Names
    const { data: mappings, error: mErr } = await supabase
        .from('company_person_mapping')
        .select(`
            person_id,
            company_id,
            companies (id, company_name)
        `);

    if (mErr) throw mErr;

    // 3. Get all IDs grouped by Company
    const { data: identifiers, error: iErr } = await supabase
        .from('agent_identifiers')
        .select(`
            id_string,
            agents (company_id)
        `);

    if (iErr) throw iErr;

    // --- DATA STITCHING ---
    const finalData = persons.map(p => {
        // Find companies for this person
        const myMappings = mappings.filter(m => m.person_id === p.id);
        
        const myCompanies = myMappings.map(m => {
            const co = m.companies;
            if (!co) return null;

            // Find all IDs that belong to this company
            const myIds = identifiers
                .filter(idObj => idObj.agents?.company_id === co.id)
                .map(idObj => idObj.id_string);

            return {
                id: co.id,
                name: co.company_name,
                ids: myIds
            };
        }).filter(Boolean);

        return {
            id: p.id,
            name: `${p.first_name} ${p.last_name}`,
            companies: myCompanies
        };
    });

    return res.status(200).json({ success: true, data: finalData });
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
