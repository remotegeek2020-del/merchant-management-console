import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, person_id } = req.body || {};

    try {
       if (action === 'get_partners_list') {
    // 1. Get Names from app_users
    const { data: users, error: uErr } = await supabase
        .from('app_users')
        .select('userid, first_name, last_name');
    if (uErr) throw uErr;

    // 2. Get Mappings (Person -> Company)
    const { data: mappings, error: mErr } = await supabase
        .from('company_person_mapping')
        .select(`person_id, company_id, companies(id, company_name)`);
    if (mErr) throw mErr;

    // 3. THE FIX: Fetch all identifiers and the company they belong to
    // We select FROM agent_identifiers and JOIN agents to get the company_id
    const { data: idData, error: iErr } = await supabase
        .from('agent_identifiers')
        .select(`
            id_string,
            agents:agent_id (
                company_id
            )
        `);
    if (iErr) throw iErr;

    // --- STITCHING ---
    const finalData = users.map(u => {
        const myMappings = mappings.filter(m => m.person_id === u.userid);
        
        const myCompanies = myMappings.map(m => {
            const co = m.companies;
            if (!co) return null;

            // Look for any ID where the agent's company_id matches this company's ID
            const myIds = idData
                .filter(item => item.agents && item.agents.company_id === co.id)
                .map(item => item.id_string);

            return {
                id: co.id,
                name: co.company_name,
                ids: myIds // Now checks the agent_id -> company_id link
            };
        }).filter(Boolean);

        if (myCompanies.length === 0) return null;

        return {
            id: u.userid,
            name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
            companies: myCompanies
        };
    }).filter(Boolean);

    return res.status(200).json({ success: true, data: finalData });
}
