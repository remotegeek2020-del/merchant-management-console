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
        if (action === 'get_partners_list') {
            // 1. Fetch ONLY the ID from persons to prevent the "column not found" error
            const { data: persons, error: pErr } = await supabase
                .from('persons')
                .select('id'); 
            
            if (pErr) throw pErr;

            // 2. Fetch Mappings with Company info
            const { data: mappings, error: mErr } = await supabase
                .from('company_person_mapping')
                .select(`
                    person_id,
                    company_id,
                    companies (id, company_name)
                `);
            if (mErr) throw mErr;

            // 3. Fetch All Identifiers
            const { data: idData, error: iErr } = await supabase
                .from('agent_identifiers')
                .select(`
                    id_string,
                    agents (company_id)
                `);
            if (iErr) throw iErr;

            // --- STITCHING ---
            const finalData = persons.map(p => {
                const myMappings = mappings.filter(m => m.person_id === p.id);
                
                const myCompanies = myMappings.map(m => {
                    const co = m.companies;
                    if (!co) return null;

                    const myIds = idData
                        .filter(item => item.agents?.company_id === co.id)
                        .map(item => item.id_string);

                    return {
                        id: co.id,
                        name: co.company_name,
                        ids: myIds
                    };
                }).filter(Boolean);

                return {
                    id: p.id,
                    // Temporarily use the ID as the name to verify the link works
                    name: `Partner ${p.id.substring(0, 5)}`, 
                    companies: myCompanies
                };
            });

            return res.status(200).json({ success: true, data: finalData });
        }

        // ... keep your get_hierarchy action here ...

    } catch (err) {
        console.error("Internal API Error:", err.message);
        // Returning a JSON error instead of letting the server crash with text
        return res.status(500).json({ success: false, message: err.message });
    }
}
