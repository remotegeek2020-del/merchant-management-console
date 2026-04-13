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
    // 1. Fetch all data sets
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
        const pId = person.id;
        
        // 2. Find ALL agents where this person is the parent
        const myAgents = agents.filter(a => a.parent_agent_id === pId);
        
        // If they don't own any agents, we don't show the card
        if (myAgents.length === 0) return null;

        // 3. Map IDs to their Company Names
        const groups = {};

        myAgents.forEach(agent => {
            // Find company name OR use Independent
            const coMatch = companies.find(c => c.id === agent.company_id);
            const coName = coMatch ? coMatch.company_name : "Independent / No Company";
            
            if (!groups[coName]) groups[coName] = [];

            // Get the numeric IDs for this specific agent record
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

        // 4. Transform groups into the Array format for the UI
        const formattedCompanies = Object.keys(groups).map(name => ({
            name: name,
            ids: groups[name]
        })).filter(g => g.ids.length > 0);

        // Safety check: If they own agents but those agents have no IDs yet, 
        // we still want to show the card but with an empty list or specific note.
        return {
            id: person.id,
            name: person.full_name,
            companies: formattedCompanies
        };
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
