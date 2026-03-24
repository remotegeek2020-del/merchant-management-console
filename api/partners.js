import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, person_id } = req.body || {};

    try {
        if (action === 'get_partners_list') {
            // 1. Get all Companies (The Anchor)
            const { data: companies } = await supabase.from('companies').select('id, company_name');
            
            // 2. Get the Person Mappings
            const { data: mappings } = await supabase.from('company_person_mapping').select('person_id, company_id');
            
            // 3. Get Human Names
            const { data: users } = await supabase.from('app_users').select('userid, first_name, last_name');
            
            // 4. Get Agent Records (to check Parent/Sub relationships)
            const { data: agents } = await supabase.from('agents').select('id, company_id, parent_agent_id');
            
            // 5. Get the actual ID Strings
            const { data: idStrings } = await supabase.from('agent_identifiers').select('id_string, agent_id');

            // --- RECURSIVE STITCHING ---
            // We group by PERSON_ID first so Agent A doesn't show up twice
            const personGroups = {};

            mappings.forEach(map => {
                const pid = map.person_id;
                if (!personGroups[pid]) {
                    const u = users?.find(user => user.userid === pid);
                    personGroups[pid] = {
                        id: pid,
                        name: u ? `${u.first_name} ${u.last_name}` : `Partner ${pid.substring(0,5)}`,
                        companies: []
                    };
                }

                const co = companies?.find(c => c.id === map.company_id);
                if (co) {
                    // Find agents for this company
                    const coAgents = agents?.filter(a => a.company_id === co.id) || [];
                    const coAgentIds = coAgents.map(a => a.id);
                    
                    // Find ID strings
                    const identifiers = idStrings?.filter(is => coAgentIds.includes(is.agent_id)).map(is => is.id_string) || [];

                    // Check for Hierarchy: 
                    // Downline: Agents who have one of THIS company's agents as a parent
                    const downlineCount = agents?.filter(a => coAgentIds.includes(a.parent_agent_id)).length || 0;
                    
                    // Upline: If this company's agent has a parent_agent_id that is NOT in this company
                    const uplineCount = coAgents.filter(a => a.parent_agent_id && !coAgentIds.includes(a.parent_agent_id)).length || 0;

                    personGroups[pid].companies.push({
                        name: co.company_name,
                        ids: identifiers,
                        downline: downlineCount,
                        upline: uplineCount
                    });
                }
            });

            const result = Object.values(personGroups);
            return res.status(200).json({ success: true, data: result });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
