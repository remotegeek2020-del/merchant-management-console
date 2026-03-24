import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body || {};

    if (action !== 'get_partners_list') return res.status(400).json({ success: false });

    try {
        const [pRes, mRes, cRes, aRes, iRes] = await Promise.all([
            supabase.from('persons').select('id, full_name'),
            supabase.from('company_person_mapping').select('person_id, company_id'),
            supabase.from('companies').select('id, company_name'),
            supabase.from('agents').select('id, company_id'),
            supabase.from('agent_identifiers').select('*') // Fetch EVERYTHING to be safe
        ]);

        const persons = pRes.data || [];
        const mappings = mRes.data || [];
        const companies = cRes.data || [];
        const agents = aRes.data || [];
        const identifiers = iRes.data || [];

        const finalData = persons.map(p => {
            const pId = String(p.id);
            const myCompanyIds = mappings.filter(m => String(m.person_id) === pId).map(m => String(m.company_id));
            
            const myCompanies = companies.filter(c => myCompanyIds.includes(String(c.id))).map(co => {
                const coId = String(co.id);
                const coAgentUuids = agents.filter(a => String(a.company_id) === coId).map(a => String(a.id));
                
                // We use id_string OR agent_id as a fallback
                const myIds = identifiers
                    .filter(i => coAgentUuids.includes(String(i.agent_id)))
                    .map(id => ({
                        string: id.id_string || id.agent_id || "Unknown",
                        rev: id.rev_share || '0%',
                        isPrime: !!id.prime49
                    }));

                return { name: co.company_name, ids: myIds };
            });

            return myCompanies.length > 0 ? { id: p.id, name: p.full_name, companies: myCompanies } : null;
        }).filter(Boolean);

        return res.status(200).json({ success: true, data: finalData });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
