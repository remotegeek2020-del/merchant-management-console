import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    
    const supabase = createClient(
        process.env.SUPABASE_URL, 
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const body = req.body || {};
    const { action } = body;

    try {
        if (action === 'get_partners_list') {
            // 1. Fetch all data points separately (Isolated to find the exact failure point)
            const { data: persons, error: pErr } = await supabase.from('persons').select('id, full_name');
            if (pErr) throw new Error(`Persons Table: ${pErr.message}`);

            const { data: mappings, error: mErr } = await supabase.from('company_person_mapping').select('person_id, company_id');
            if (mErr) throw new Error(`Mapping Table: ${mErr.message}`);

            const { data: companies, error: cErr } = await supabase.from('companies').select('id, company_name');
            if (cErr) throw new Error(`Companies Table: ${cErr.message}`);

            const { data: agents, error: agErr } = await supabase.from('agents').select('id, company_id');
            if (agErr) throw new Error(`Agents Table: ${agErr.message}`);

            // This is the most likely spot for a typo or permission error
            const { data: agentData, error: aErr } = await supabase.from('agent_identifiers').select('id_string, agent_id, rev_share, prime49');
            if (aErr) throw new Error(`Identifiers Table: ${aErr.message}`);

            // 2. Stitch the data in JavaScript
            const finalData = persons.map(p => {
                // Find companies for this person via mapping
                const myCompanyIds = mappings
                    .filter(m => m.person_id === p.id)
                    .map(m => m.company_id);
                
                const myCompanies = companies
                    .filter(c => myCompanyIds.includes(c.id))
                    .map(co => {
                        // Find agents belonging to this company
                        const coAgents = agents
                            .filter(a => a.company_id === co.id)
                            .map(a => a.id);
                        
                        // Find identifiers tied to those agents
                        const myIdentifiers = agentData
                            .filter(ad => coAgents.includes(ad.agent_id))
                            .map(id => ({
                                string: id.id_string,
                                rev: id.rev_share || '0%',
                                isPrime: id.prime49 || false
                            }));

                        return {
                            name: co.company_name,
                            ids: myIdentifiers
                        };
                    })
                    .filter(item => item.ids.length > 0 || item.name);

                if (myCompanies.length === 0) return null;

                return {
                    id: p.id,
                    name: p.full_name,
                    companies: myCompanies
                };
            }).filter(Boolean);

            return res.status(200).json({ success: true, data: finalData });
        }

        // Add other actions (like get_hierarchy) here if needed

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error("API Error:", err.message);
        // We return a JSON object so the frontend doesn't get that "Unexpected Token A"
        return res.status(500).json({ 
            success: false, 
            message: err.message 
        });
    }
}
