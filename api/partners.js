import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, person_id } = req.body || {};

    try {
        if (action === 'get_partners_list') {
            // 1. Get Human Names (Michelle Collins) from app_users
            const { data: users, error: uErr } = await supabase
                .from('app_users')
                .select('userid, first_name, last_name');
            if (uErr) throw uErr;

            // 2. Get Mappings (Links the Person to the Company)
            const { data: mappings, error: mErr } = await supabase
                .from('company_person_mapping')
                .select(`person_id, company_id, companies(id, company_name)`);
            if (mErr) throw mErr;

            // 3. Get Identifiers (The ID Strings) and the Company they belong to
            // This follows: agent_identifiers -> agent_id -> agents -> company_id
            const { data: idData, error: iErr } = await supabase
                .from('agent_identifiers')
                .select(`
                    id_string,
                    agents:agent_id (
                        company_id
                    )
                `);
            if (iErr) throw iErr;

            // --- DATA STITCHING (Following your exact path) ---
            const finalData = users.map(u => {
                // Find companies for this person
                const myMappings = mappings.filter(m => m.person_id === u.userid);
                
                const myCompanies = myMappings.map(m => {
                    const co = m.companies;
                    if (!co) return null;

                    // Find all IDs where the Agent record's company_id matches this Company
                    const myIds = idData
                        .filter(item => item.agents && item.agents.company_id === co.id)
                        .map(item => item.id_string);

                    return {
                        id: co.id,
                        name: co.company_name,
                        ids: myIds // This will now catch Chellecom & TrueNorth
                    };
                }).filter(Boolean);

                // Only show cards for people who are actually mapped to companies (Partners)
                if (myCompanies.length === 0) return null;

                return {
                    id: u.userid,
                    name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
                    companies: myCompanies
                };
            }).filter(Boolean);

            return res.status(200).json({ success: true, data: finalData });
        }

        // --- SUB-AGENT HIERARCHY ---
        if (action === 'get_hierarchy') {
            // Find agents whose parent is the selected person's agent record
            const { data: subs, error: subError } = await supabase
                .from('agents')
                .select(`
                    id, 
                    agent_name, 
                    agent_identifiers (id_string)
                `)
                .eq('parent_agent_id', person_id);

            if (subError) throw subError;
            return res.status(200).json({ success: true, data: subs });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error("Partners API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
