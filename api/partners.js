import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body || {};

    if (action !== 'get_partners_list') return res.status(400).json({ success: false });

    try {
        // 1. Get the Core Data
        const { data: persons } = await supabase.from('persons').select('id, full_name');
        const { data: mappings } = await supabase.from('company_person_mapping').select('person_id, company_id');
        const { data: companies } = await supabase.from('companies').select('id, company_name');
        
        // 2. Here's the fix: We get the ID strings and the agents they belong to
        const { data: idStrings } = await supabase.from('agent_identifiers').select(`
            id_string, 
            rev_share, 
            prime49,
            agents (company_id)
        `);

        const finalData = persons.map(p => {
            const myCompanyIds = mappings.filter(m => m.person_id === p.id).map(m => m.company_id);
            
            const myCompanies = companies.filter(c => myCompanyIds.includes(c.id)).map(co => {
                // Find all ID strings where the parent agent's company_id matches this company
                const myIds = idStrings?.filter(is => is.agents?.company_id === co.id).map(id => ({
                    string: id.id_string,
                    rev: id.rev_share || '0%',
                    isPrime: !!id.prime49
                })) || [];

                return {
                    name: co.name || co.company_name,
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
        return res.status(500).json({ success: false, message: err.message });
    }
}
