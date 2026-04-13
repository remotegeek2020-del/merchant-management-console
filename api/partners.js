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
        // Normalize the Person ID to ensure a match
        const pId = String(person.id || '').toLowerCase().trim();
        
        // Find every agent record where THIS person is the parent
        const myAgents = (aRes.data || []).filter(a => 
            a.parent_agent_id && String(a.parent_agent_id).toLowerCase().trim() === pId
        );
        
        // If they don't own any agents in the DB, hide the card
        if (myAgents.length === 0) return null;

        const groups = {};
        myAgents.forEach(agent => {
            const coMatch = (cRes.data || []).find(c => 
                String(c.id).toLowerCase().trim() === String(agent.company_id).toLowerCase().trim()
            );
            const coName = coMatch ? coMatch.company_name : "Independent / No Company";
            
            if (!groups[coName]) groups[coName] = { name: coName, ids: [] };

            // Find all badges (numeric IDs) for this specific agent record
            const myIds = (iRes.data || [])
                .filter(i => String(i.agent_id).toLowerCase().trim() === String(agent.id).toLowerCase().trim())
                .map(id => ({
                    string: id.id_string,
                    rev: id.rev_share || '0%',
                    isPrime: !!id.prime49
                }));

            groups[coName].ids.push(...myIds);
        });

        // Convert grouped objects to array and remove empty company headers
        const formattedCompanies = Object.values(groups).filter(g => g.ids.length > 0);

        return formattedCompanies.length > 0 ? {
            id: person.id,
            name: person.full_name,
            companies: formattedCompanies
        } : null;
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
