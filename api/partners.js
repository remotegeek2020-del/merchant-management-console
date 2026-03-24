import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body || {};

    try {
        if (action === 'get_partners_list') {
    try {
        // 1. Fetch all data points separately (Prevents Join Crashes)
        const { data: persons, error: pErr } = await supabase.from('persons').select('id, full_name');
        if (pErr) throw pErr;

        const { data: mappings, error: mErr } = await supabase.from('company_person_mapping').select('person_id, company_id');
        if (mErr) throw mErr;

        const { data: companies, error: cErr } = await supabase.from('companies').select('id, company_name');
        if (cErr) throw cErr;

        const { data: agentData, error: aErr } = await supabase.from('agent_identifiers').select('id_string, agent_id, rev_share, prime49');
        if (aErr) throw aErr;

        const { data: agents, error: agErr } = await supabase.from('agents').select('id, company_id');
        if (agErr) throw agErr;

        // 2. Stitch the data in JavaScript
        const finalData = persons.map(p => {
            // Find companies for this person via mapping
            const myCompanyIds = mappings.filter(m => m.person_id === p.id).map(m => m.company_id);
            
            const myCompanies = companies.filter(c => myCompanyIds.includes(c.id)).map(co => {
                // Find agents belonging to this company
                const coAgents = agents.filter(a => a.company_id === co.id).map(a => a.id);
                
                // Find identifiers tied to those agents
                const myIdentifiers = agentData.filter(ad => coAgents.includes(ad.agent_id)).map(id => ({
                    string: id.id_string,
                    rev: id.rev_share || '0%',
                    isPrime: id.prime49 || false
                }));

                return {
                    name: co.company_name,
                    ids: myIdentifiers
                };
            }).filter(item => item.ids.length > 0 || item.name); // Keep company even if no IDs yet

            if (myCompanies.length === 0) return null;

            return {
                id: p.id,
                name: p.full_name,
                companies: myCompanies
            };
        }).filter(Boolean);

        return res.status(200).json({ success: true, data: finalData });

    } catch (dbError) {
        console.error("Database Error:", dbError);
        return res.status(500).json({ success: false, message: dbError.message });
    }
}
