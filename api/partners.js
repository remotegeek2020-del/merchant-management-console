import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    
    const supabase = createClient(
        process.env.SUPABASE_URL, 
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { action, person_id } = req.body || {};

    try {
     if (action === 'get_partners_list') {
    // 1. Fetch persons using only the columns visible in your screenshot
    // If 'name' doesn't exist either, we just fetch 'id'
    const { data: persons, error: pErr } = await supabase
        .from('persons')
        .select('id'); // Removed first_name/last_name to stop the "Column not found" error
    
    if (pErr) throw pErr;

    // 2. Fetch Mappings
    const { data: mappings, error: mErr } = await supabase
        .from('company_person_mapping')
        .select(`person_id, company_id, companies(company_name)`);

    if (mErr) throw mErr;

    // 3. Fetch Identifiers
    const { data: idData, error: iErr } = await supabase
        .from('agent_identifiers')
        .select(`id_string, agents(company_id)`);

    if (iErr) throw iErr;

    // --- STITCHING ---
    const finalData = persons.map(p => {
        const myMappings = mappings.filter(m => m.person_id === p.id);
        const myCompanies = myMappings.map(m => {
            const co = m.companies;
            const myIds = idData
                .filter(item => item.agents?.company_id === co?.id)
                .map(item => item.id_string);

            return {
                id: co?.id,
                name: co?.company_name || 'Unknown Company',
                ids: myIds
            };
        }).filter(c => c.id);

        return {
            id: p.id,
            // Since we can't find first_name, let's use a placeholder 
            // or the ID for now so you can at least see the cards!
            name: `Partner (${p.id.substring(0,8)})`, 
            companies: myCompanies
        };
    });

    return res.status(200).json({ success: true, data: finalData });
}
