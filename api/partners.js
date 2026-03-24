import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, person_id } = req.body || {};

    try {
       if (action === 'get_partners_list') {
    // 1. Get all base data
    const { data: persons } = await supabase.from('persons').select('id');
    const { data: users } = await supabase.from('app_users').select('userid, first_name, last_name, email');
    const { data: mappings } = await supabase.from('company_person_mapping').select(`person_id, company_id, companies(id, company_name)`);
    const { data: agents } = await supabase.from('agents').select('id, company_id, agent_name, parent_agent_id');
    const { data: idStrings } = await supabase.from('agent_identifiers').select('id_string, agent_id');

    const finalData = persons.map(p => {
        // --- NAME DISCOVERY LOGIC ---
        // Try 1: Match by app_users.userid
        let userMatch = users?.find(u => u.userid === p.id);
        
        // Try 2: If no match, try matching app_users.email to the persons ID (if ID is an email)
        if (!userMatch) userMatch = users?.find(u => u.email === p.id);

        let displayName = "";
        if (userMatch) {
            displayName = `${userMatch.first_name || ''} ${userMatch.last_name || ''}`.trim();
        } 
        
        // Try 3: Look at the Agents table for a name linked to this person's companies
        if (!displayName) {
            const firstAgent = agents?.find(a => 
                mappings?.find(m => m.person_id === p.id && m.company_id === a.company_id)
            );
            displayName = firstAgent?.agent_name || `Partner ${p.id.substring(0, 5)}`;
        }

        // --- COMPANY & ID MAPPING ---
        const myMappings = mappings?.filter(m => m.person_id === p.id) || [];
        const myCompanies = myMappings.map(m => {
            const co = m.companies;
            if (!co) return null;

            const coAgents = agents?.filter(a => a.company_id === co.id) || [];
            const coAgentUuids = coAgents.map(a => a.id);
            const identifiers = idStrings?.filter(is => coAgentUuids.includes(is.agent_id)).map(is => is.id_string) || [];

            // Hierarchy calculations (Recursive)
            const downlineCount = agents?.filter(a => coAgentUuids.includes(a.parent_agent_id)).length || 0;
            const uplineCount = coAgents.filter(a => a.parent_agent_id && !coAgentUuids.includes(a.parent_agent_id)).length || 0;

            return {
                name: co.company_name,
                ids: identifiers,
                downline: downlineCount,
                upline: uplineCount
            };
        }).filter(Boolean);

        if (myCompanies.length === 0) return null;

        return {
            id: p.id,
            name: displayName,
            companies: myCompanies
        };
    }).filter(Boolean);

    return res.status(200).json({ success: true, data: finalData });
}
