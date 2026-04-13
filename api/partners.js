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
    // Helper function to bypass the 1,000-row limit
    async function fetchAll(table, select) {
        let allData = [];
        let from = 0;
        let to = 999;
        let finished = false;
        while (!finished) {
            const { data, error } = await supabase.from(table).select(select).range(from, to);
            if (error || !data || data.length === 0) { finished = true; }
            else {
                allData = allData.concat(data);
                from += 1000; to += 1000;
                if (data.length < 1000) finished = true;
            }
        }
        return allData;
    }

    // Fetch full datasets
    const [persons, agents, identifiers, companies] = await Promise.all([
        fetchAll('persons', 'id, full_name'),
        fetchAll('agents', 'id, company_id, parent_agent_id'),
        fetchAll('agent_identifiers', 'agent_id, id_string, rev_share, prime49'),
        fetchAll('companies', 'id, company_name')
    ]);

    const finalData = persons.map(person => {
        const pId = String(person.id).toLowerCase().trim();
        const myAgents = agents.filter(a => 
            a.parent_agent_id && String(a.parent_agent_id).toLowerCase().trim() === pId
        );
        
        if (myAgents.length === 0) return null;

        const groups = {};
        myAgents.forEach(agent => {
            const coMatch = companies.find(c => c.id === agent.company_id);
            const coName = coMatch ? coMatch.company_name : "Independent / No Company";
            
            if (!groups[coName]) groups[coName] = { name: coName, ids: [] };

            const myIds = identifiers
                .filter(i => i.agent_id && String(i.agent_id).toLowerCase().trim() === String(agent.id).toLowerCase().trim())
                .map(id => ({
                    string: id.id_string,
                    rev: id.rev_share || '0%',
                    isPrime: !!id.prime49
                }));

            groups[coName].ids.push(...myIds);
        });

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
