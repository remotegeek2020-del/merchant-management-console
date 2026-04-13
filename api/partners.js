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
        supabase.from('agent_identifiers').select('id, agent_id, id_string, rev_share, prime49'),
        supabase.from('companies').select('id, company_name')
    ]);

    const persons = pRes.data || [];
    const agents = aRes.data || [];
    const identifiers = iRes.data || [];
    const companies = cRes.data || [];

    const finalData = persons.map(person => {
        const pId = String(person.id).toLowerCase();
        
        // 1. Find agents owned by this person
        const myAgents = agents.filter(a => a.parent_agent_id && String(a.parent_agent_id).toLowerCase() === pId);
        
        if (myAgents.length === 0) return null;

        const groups = {};
        myAgents.forEach(agent => {
            const coMatch = companies.find(c => c.id === agent.company_id);
            const coName = coMatch ? coMatch.company_name : "Independent / No Company";
            
            if (!groups[coName]) groups[coName] = [];

            const myIds = identifiers
                .filter(i => i.agent_id === agent.id)
                .map(id => ({
                    string: id.id_string,
                    rev: id.rev_share || '0%',
                    isPrime: !!id.prime49,
                    db_id: id.id
                }));

            groups[coName].push(...myIds);
        });

        const formattedCompanies = Object.entries(groups)
            .map(([name, ids]) => ({ name, ids }))
            .filter(g => g.ids.length > 0);

        return formattedCompanies.length > 0 ? {
            id: person.id,
            name: person.full_name,
            companies: formattedCompanies
        } : null;
    }).filter(Boolean);

    return res.status(200).json({ success: true, data: finalData });
}
        // --- ACTION: UPDATE IDENTIFIER ---
        if (action === 'update_identifier') {
            const { error } = await supabase
                .from('agent_identifiers')
                .update({ rev_share: payload.rev_share, prime49: payload.prime49 })
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
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
