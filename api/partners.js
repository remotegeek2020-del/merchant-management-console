import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body || {};

    try {
        if (action === 'get_partners_list') {
            const { data: persons } = await supabase.from('persons').select('id, full_name');
            const { data: mappings } = await supabase.from('company_person_mapping').select(`person_id, company_id, companies(id, company_name)`);
            
            // Fetching the new rev_share and prime49 columns here
            const { data: agentData } = await supabase.from('agent_identifiers').select(`
                id_string,
                rev_share,
                prime49,
                agents:agent_id (company_id)
            `);

            const finalData = persons.map(p => {
                const myMappings = mappings?.filter(m => m.person_id === p.id) || [];
                const myCompanies = myMappings.map(m => {
                    const co = m.companies;
                    if (!co) return null;

                    // Get IDs tied to this specific company for this person
                    const identifiers = agentData?.filter(ad => ad.agents?.company_id === co.id) || [];

                    return {
                        name: co.company_name,
                        ids: identifiers.map(i => ({
                            string: i.id_string,
                            rev: i.rev_share,
                            isPrime: i.prime49
                        }))
                    };
                }).filter(Boolean);

                if (myCompanies.length === 0) return null;

                return {
                    id: p.id,
                    name: p.full_name,
                    companies: myCompanies
                };
            }).filter(Boolean);

            return res.status(200).json({ success: true, data: finalData });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
