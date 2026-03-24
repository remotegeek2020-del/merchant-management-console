import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body || {};

    if (action !== 'get_partners_list') {
        return res.status(400).json({ success: false, message: "Invalid Action" });
    }

    try {
        // 1. Fetch data with extreme caution
        const [pRes, mRes, cRes, aRes, iRes] = await Promise.all([
            supabase.from('persons').select('id, full_name'),
            supabase.from('company_person_mapping').select('person_id, company_id'),
            supabase.from('companies').select('id, company_name'),
            supabase.from('agents').select('id, company_id'),
            supabase.from('agent_identifiers').select('id_string, agent_id, rev_share, prime49')
        ]);

        // Check for any database errors immediately
        if (pRes.error) throw new Error("Persons: " + pRes.error.message);
        if (iRes.error) throw new Error("Identifiers: " + iRes.error.message);

        const persons = pRes.data || [];
        const mappings = mRes.data || [];
        const companies = cRes.data || [];
        const agents = aRes.data || [];
        const identifiers = iRes.data || [];

        // 2. Stitch with safety checks
        const finalData = persons.map(p => {
            const myCompanyIds = mappings
                .filter(m => m.person_id === p.id)
                .map(m => m.company_id);

            const myCompanies = companies
                .filter(c => myCompanyIds.includes(c.id))
                .map(co => {
                    const coAgentIds = agents
                        .filter(a => a.company_id === co.id)
                        .map(a => a.id);

                    const myIds = identifiers
                        .filter(i => coAgentIds.includes(i.agent_id))
                        .map(i => ({
                            string: i.id_string,
                            rev: i.rev_share || '0%',
                            isPrime: !!i.prime49 // Forces to boolean
                        }));

                    return { name: co.company_name, ids: myIds };
                });

            // Only return persons who actually have a company mapping
            return myCompanies.length > 0 ? { id: p.id, name: p.full_name, companies: myCompanies } : null;
        }).filter(Boolean);

        return res.status(200).json({ success: true, data: finalData });

    } catch (err) {
        console.error("Internal Server Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
