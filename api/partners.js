import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    
    const supabase = createClient(
        process.env.SUPABASE_URL, 
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const body = req.body || {};
    const { action, person_id } = body;

    try {
        // --- ACTION: GET PARTNERS LIST (Unified Stitching) ---
        if (action === 'get_partners_list') {
            // 1. Fetch all Persons
            const { data: persons, error: pErr } = await supabase
                .from('persons')
                .select('id, first_name, last_name');
            if (pErr) throw pErr;

            // 2. Fetch all Mappings with Company names
            const { data: mappings, error: mErr } = await supabase
                .from('company_person_mapping')
                .select(`
                    person_id,
                    company_id,
                    companies (id, company_name)
                `);
            if (mErr) throw mErr;

            // 3. Fetch all Identifiers linked to their Company
            const { data: identifiers, error: iErr } = await supabase
                .from('agent_identifiers')
                .select(`
                    id_string,
                    agents (company_id)
                `);
            if (iErr) throw iErr;

            // --- DATA STITCHING ---
            const finalData = persons.map(p => {
                // Find companies linked to this person
                const myMappings = mappings.filter(m => m.person_id === p.id);
                
                const myCompanies = myMappings.map(m => {
                    const co = m.companies;
                    if (!co) return null;

                    // Filter identifiers belonging to this specific company
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
                    name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
                    companies: myCompanies
                };
            });

            return res.status(200).json({ success: true, data: finalData });
        }

        // --- ACTION: GET SUB-AGENTS (Hierarchy) ---
        if (action === 'get_hierarchy') {
            if (!person_id) return res.status(400).json({ success: false, message: "Missing person_id" });

            // 1. Find all Company IDs for this person
            const { data: userCompanies } = await supabase
                .from('company_person_mapping')
                .select('company_id')
                .eq('person_id', person_id);

            const companyIds = userCompanies?.map(c => c.company_id) || [];

            if (companyIds.length === 0) {
                return res.status(200).json({ success: true, data: [] });
            }

            // 2. Find Agent UUIDs for those companies
            const { data: myAgents } = await supabase
                .from('agents')
                .select('id')
                .in('company_id', companyIds);

            const myAgentUuids = myAgents?.map(a => a.id) || [];

            if (myAgentUuids.length === 0) {
                return res.status(200).json({ success: true, data: [] });
            }

            // 3. Find sub-agents where parent_agent_id is one of Michelle's IDs
            const { data: subs, error: subError } = await supabase
                .from('agents')
                .select(`
                    id, 
                    agent_name, 
                    parent_agent_id,
                    agent_identifiers (id_string)
                `)
                .in('parent_agent_id', myAgentUuids);

            if (subError) throw subError;
            return res.status(200).json({ success: true, data: subs });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error("Partner API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
