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
    const [persons, agents, identifiers, companies] = await Promise.all([
        fetchAll('persons', 'id, full_name'),
        fetchAll('agents', 'id, company_id, parent_agent_id'),
        fetchAll('agent_identifiers', 'id, agent_id, id_string, rev_share, prime49, parent_config_id'),
        fetchAll('companies', 'id, company_name')
    ]);

    // 1. Create a fast-lookup map for all identifiers
    const idMap = {};
    identifiers.forEach(id => {
        idMap[id.id] = {
            ...id,
            string: id.id_string,
            rev: id.rev_share || '0%',
            isPrime: !!id.prime49,
            sub_ids: [] // Placeholder for children
        };
    });

    // 2. Build the tree structure without recursion (Flat-to-Tree)
    const rootIdsByAgent = {};
    identifiers.forEach(id => {
        const current = idMap[id.id];
        if (id.parent_config_id && idMap[id.parent_config_id]) {
            // Push this ID into its parent's sub_ids array
            idMap[id.parent_config_id].sub_ids.push(current);
        } else {
            // No parent? It's a root ID for its specific agent record
            if (!rootIdsByAgent[id.agent_id]) rootIdsByAgent[id.agent_id] = [];
            rootIdsByAgent[id.agent_id].push(current);
        }
    });

    // 3. Assemble the final partner data
    const finalData = persons.map(person => {
        const pId = String(person.id).toLowerCase().trim();
        const myAgents = agents.filter(a => String(a.parent_agent_id || '').toLowerCase().trim() === pId);
        
        if (myAgents.length === 0) return null;

        const companyGroups = {};
        myAgents.forEach(agent => {
            const coMatch = companies.find(c => c.id === agent.company_id);
            const coName = coMatch ? coMatch.company_name : "Independent / No Company";
            
            const idsForThisAgent = rootIdsByAgent[agent.id] || [];
            if (idsForThisAgent.length > 0) {
                if (!companyGroups[coName]) companyGroups[coName] = [];
                companyGroups[coName].push(...idsForThisAgent);
            }
        });

        const formattedCompanies = Object.entries(companyGroups).map(([name, ids]) => ({ name, ids }));

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
