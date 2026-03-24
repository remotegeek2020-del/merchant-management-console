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
        // 1. Fetch all data points in parallel
        const [pRes, mRes, cRes, aRes, iRes] = await Promise.all([
            supabase.from('persons').select('id, full_name'),
            supabase.from('company_person_mapping').select('person_id, company_id'),
            supabase.from('companies').select('id, company_name'),
            supabase.from('agents').select('id, company_id'),
            supabase.from('agent_identifiers').select('id_string, agent_id, rev_share, prime49')
        ]);

        if (pRes.error) throw pRes.error;
        if (iRes.error) throw iRes.error;

        const persons = pRes.data || [];
        const mappings = mRes.data || [];
        const companies = cRes.data || [];
        const agents = aRes.data || [];
        const identifiers = iRes.data || [];

        // 2. Stitch the Data with Type-Safe Matching
        const finalData = persons.map(p => {
            // Force Person ID to string for comparison
            const personIdStr = String(p.id).trim();

            const myCompanyIds = mappings
                .filter(m => String(m.person_id).trim() === personIdStr)
                .map(m => String(m.company_id).trim());
            
            const myCompanies = companies
                .filter(c => myCompanyIds.includes(String(c.id).trim()))
                .map(co => {
                    const companyIdStr = String(co.id).trim();

                    // Find any agent UUIDs linked to this company
                    const coAgentUuids = agents
                        .filter(a => String(a.company_id).trim() === companyIdStr)
                        .map(a => String(a.id).trim());
                    
                    // Find all ID strings (Partner IDs) linked to those agent UUIDs
                    const myIds = identifiers
                        .filter(i => coAgentUuids.includes(String(i.agent_id).trim()))
                        .map(id => ({
                            string: id.id_string,
                            rev: id.rev_share || '0%',
                            isPrime: !!id.prime49 
                        }));

                    return {
                        name: co.company_name,
                        ids: myIds
                    };
                });

            if (myCompanies.length === 0) return null;

            return {
                id: p.id,
                name: p.full_name,
                companies: myCompanies
            };
        }).filter(Boolean);

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("Dashboard API Error:", err.message);
        return res.status(500).json({ 
            success: false, 
            message: err.message 
        });
    }
}
