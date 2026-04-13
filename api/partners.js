import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, person_id, id, payload } = body;

    if (!action) return res.status(400).json({ success: false, message: "No action provided" });

    try {
        // --- ACTION: GET PARTNERS LIST (Owner-Specific Logic) ---
if (action === 'get_partners_list') {
    const [pRes, aRes, iRes, cRes] = await Promise.all([
        supabase.from('persons').select('id, full_name'),
        supabase.from('agents').select('id, company_id, parent_agent_id'),
        supabase.from('agent_identifiers').select('agent_id, id_string, rev_share, prime49'),
        supabase.from('companies').select('id, company_name')
    ]);

    const finalData = (pRes.data || []).map(person => {
        const pId = String(person.id).toLowerCase().trim();
        
        // Find all agent records owned by this person
        const myAgents = (aRes.data || []).filter(a => 
            a.parent_agent_id && String(a.parent_agent_id).toLowerCase().trim() === pId
        );
        
        if (myAgents.length === 0) return null;

        const groupMap = {};
        myAgents.forEach(agent => {
            const agentId = String(agent.id).toLowerCase().trim();
            const coMatch = (cRes.data || []).find(c => 
                String(c.id).toLowerCase().trim() === String(agent.company_id || '').toLowerCase().trim()
            );
            const coName = coMatch ? coMatch.company_name : "Independent / No Company";
            
            if (!groupMap[coName]) groupMap[coName] = [];

            // Pull every numeric ID linked to this specific agent record
            const myIds = (iRes.data || [])
                .filter(i => i.agent_id && String(i.agent_id).toLowerCase().trim() === agentId)
                .map(id => ({
                    string: id.id_string,
                    rev: id.rev_share || '0%',
                    isPrime: !!id.prime49
                }));

            groupMap[coName].push(...myIds);
        });

        const formattedCompanies = Object.entries(groupMap).map(([name, ids]) => ({
            name,
            ids: ids.filter(item => item.string)
        }));

        return {
            id: person.id,
            name: person.full_name,
            companies: formattedCompanies
        };
    }).filter(Boolean);

    return res.status(200).json({ success: true, data: finalData });
}
        // --- ACTION: GET HIERARCHY ---
        if (action === 'get_hierarchy') {
            const { data: masters } = await supabase.from('agents').select('id').eq('parent_agent_id', person_id);
            const masterIds = (masters || []).map(a => a.id);

            const { data: subAgents, error } = await supabase
                .from('agents')
                .select(`agent_name, agent_identifiers (id_string, rev_share)`)
                .in('parent_agent_id', masterIds);

            if (error) throw error;
            return res.status(200).json({ success: true, data: subAgents || [] });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
