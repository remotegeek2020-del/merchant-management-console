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
        // 1. Fetch all tables in parallel
        const [pRes, mRes, cRes, aRes, iRes] = await Promise.all([
            supabase.from('persons').select('id, full_name'),
            supabase.from('company_person_mapping').select('person_id, company_id'),
            supabase.from('companies').select('id, company_name'),
            supabase.from('agents').select('id, company_id'),
            supabase.from('agent_identifiers').select('*') 
        ]);

        if (pRes.error) throw pRes.error;
        if (iRes.error) throw iRes.error;

        const persons = pRes.data || [];
        const mappings = mRes.data || [];
        const companies = cRes.data || [];
        const agents = aRes.data || [];
        const identifiers = iRes.data || [];

        // 2. Stitch Data with Strict String Matching
        const finalData = persons.map(p => {
            const pId = String(p.id).toLowerCase().trim();
            
            // Find Company IDs for this Person
            const myCompanyIds = mappings
                .filter(m => String(m.person_id).toLowerCase().trim() === pId)
                .map(m => String(m.company_id).toLowerCase().trim());
            
            // Map those IDs to Company Objects
            const myCompanies = companies
                .filter(c => myCompanyIds.includes(String(c.id).toLowerCase().trim()))
                .map(co => {
                    const coId = String(co.id).toLowerCase().trim();

                    // Find Agent UUIDs for this Company
                    const coAgentUuids = agents
                        .filter(a => String(a.company_id).toLowerCase().trim() === coId)
                        .map(a => String(a.id).toLowerCase().trim());
                    
                    // Find Identifiers for those Agent UUIDs
                    const myIds = identifiers
                        .filter(i => i.agent_id && coAgentUuids.includes(String(i.agent_id).toLowerCase().trim()))
                        .map(id => ({
                            string: id.id_string || "Missing ID",
                            rev: id.rev_share || '0%',
                            isPrime: !!id.prime49
                        }));

                    return { 
                        name: co.company_name, 
                        ids: myIds 
                    };
                });

            // Only return the partner if they have mapped companies
            if (myCompanies.length === 0) return null;

            return { 
                id: p.id, 
                name: p.full_name, 
                companies: myCompanies 
            };
        }).filter(Boolean);

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
