import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    
    const supabase = createClient(
        process.env.SUPABASE_URL, 
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { action } = req.body || {};

    if (action !== 'get_partners_list') {
        return res.status(400).json({ success: false, message: "Invalid action" });
    }

    try {
        // 1. Fetch all data points in parallel for better performance
        const [pRes, mRes, cRes, aRes, iRes] = await Promise.all([
            supabase.from('persons').select('id, full_name'),
            supabase.from('company_person_mapping').select('person_id, company_id'),
            supabase.from('companies').select('id, company_name'),
            supabase.from('agents').select('id, company_id'),
            supabase.from('agent_identifiers').select('id_string, agent_id, rev_share, prime49')
        ]);

        // Error checking for the fetch results
        if (pRes.error) throw pRes.error;
        if (iRes.error) throw iRes.error;

        const persons = pRes.data || [];
        const mappings = mRes.data || [];
        const companies = cRes.data || [];
        const agents = aRes.data || [];
        const identifiers = iRes.data || [];

        // 2. Stitch the Data: Person -> Mapping -> Company -> Agent -> ID String
        const finalData = persons.map(p => {
            // Get all company IDs associated with this person
            const myCompanyIds = mappings
                .filter(m => m.person_id === p.id)
                .map(m => m.company_id);
            
            // Map those IDs to actual company objects
            const myCompanies = companies
                .filter(c => myCompanyIds.includes(c.id))
                .map(co => {
                    // Find any agent UUIDs linked to this company
                    const coAgentUuids = agents
                        .filter(a => a.company_id === co.id)
                        .map(a => a.id);
                    
                    // Find all ID strings (Partner IDs) linked to those agent UUIDs
                    const myIds = identifiers
                        .filter(i => coAgentUuids.includes(i.agent_id))
                        .map(id => ({
                            string: id.id_string,
                            rev: id.rev_share || '0%',
                            isPrime: !!id.prime49 // Double bang forces a boolean
                        }));

                    return {
                        name: co.company_name,
                        ids: myIds
                    };
                });

            // Filter out persons who don't have any companies (keeps the list clean)
            if (myCompanies.length === 0) return null;

            return {
                id: p.id,
                name: p.full_name,
                companies: myCompanies
            };
        }).filter(Boolean); // Remove the null entries

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("Dashboard API Error:", err.message);
        return res.status(500).json({ 
            success: false, 
            message: err.message 
        });
    }
}
