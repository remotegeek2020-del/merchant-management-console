import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, person_id } = req.body || {};

    try {
        if (action === 'get_partners_list') {
            // 1. Get ALL persons first (The source of truth)
            const { data: persons, error: pErr } = await supabase.from('persons').select('id');
            if (pErr) throw pErr;

            // 2. Get User names as a lookup
            const { data: users } = await supabase.from('app_users').select('userid, first_name, last_name');

            // 3. Get Mappings and Identifiers
            const { data: mappings } = await supabase.from('company_person_mapping').select(`person_id, company_id, companies(id, company_name)`);
            const { data: idData } = await supabase.from('agent_identifiers').select(`id_string, agents:agent_id(company_id)`);

            // --- RELAXED STITCHING ---
            const finalData = persons.map(p => {
                // Find name from app_users, or fallback to the ID
                const userMatch = users?.find(u => u.userid === p.id);
                const displayName = userMatch 
                    ? `${userMatch.first_name || ''} ${userMatch.last_name || ''}`.trim() 
                    : `Partner ${p.id.substring(0, 5)}`;

                // Find companies
                const myMappings = mappings?.filter(m => m.person_id === p.id) || [];
                const myCompanies = myMappings.map(m => {
                    const co = m.companies;
                    if (!co) return null;

                    const myIds = idData
                        ?.filter(item => item.agents && item.agents.company_id === co.id)
                        .map(item => item.id_string) || [];

                    return { id: co.id, name: co.company_name, ids: myIds };
                }).filter(Boolean);

                // Show all persons who have at least ONE company mapped
                if (myCompanies.length === 0) return null;

                return {
                    id: p.id,
                    name: displayName,
                    companies: myCompanies
                };
            }).filter(Boolean);

            return res.status(200).json({ success: true, data: finalData });
        }
        
        // ... hierarchy logic ...
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
