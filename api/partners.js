import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, person_id } = req.body || {};

    try {
        if (action === 'get_partners_list') {
            const { data: users } = await supabase.from('app_users').select('userid, first_name, last_name');
            const { data: mappings } = await supabase.from('company_person_mapping').select(`person_id, company_id, companies(id, company_name)`);
            const { data: agents } = await supabase.from('agents').select('id, company_id, parent_agent_id, agent_name');
            const { data: idStrings } = await supabase.from('agent_identifiers').select('id_string, agent_id');

            const finalData = users.map(u => {
                const myMappings = mappings?.filter(m => m.person_id === u.userid) || [];
                const myCompanyIds = myMappings.map(m => m.company_id);

                // IDs I OWN
                const myOwnedAgents = agents?.filter(a => myCompanyIds.includes(a.company_id)) || [];
                const myOwnedAgentUuids = myOwnedAgents.map(a => a.id);
                
                const myIdentifiers = idStrings?.filter(is => myOwnedAgentUuids.includes(is.agent_id)) || [];

                // SUB-PARTNERS REPORTING TO ME (Downline)
                const mySubPartners = agents?.filter(a => myOwnedAgentUuids.includes(a.parent_agent_id)) || [];

                // I AM A SUB-PARTNER TO (Upline)
                // Look for my agents that have a parent_agent_id NOT in my owned list
                const uplineLinks = myOwnedAgents.filter(a => a.parent_agent_id && !myOwnedAgentUuids.includes(a.parent_agent_id));

                if (myMappings.length === 0) return null;

                return {
                    id: u.userid,
                    name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
                    companies: myMappings.map(m => m.companies?.company_name),
                    owned_ids: myIdentifiers.map(i => i.id_string),
                    downline_count: mySubPartners.length,
                    upline_count: uplineLinks.length
                };
            }).filter(Boolean);

            return res.status(200).json({ success: true, data: finalData });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
