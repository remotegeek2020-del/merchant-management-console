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

    // Helper to build the recursive tree for identifiers
    const buildIdentifierTree = (parentId = null, agentId = null) => {
        return identifiers
            .filter(i => {
                const matchesParent = String(i.parent_config_id || '').toLowerCase().trim() === String(parentId || '').toLowerCase().trim();
                // If we are looking for top-level IDs, they must belong to the specific agent record
                return parentId ? matchesParent : (matchesParent && String(i.agent_id).toLowerCase().trim() === String(agentId).toLowerCase().trim());
            })
            .map(id => ({
                string: id.id_string,
                rev: id.rev_share || '0%',
                isPrime: !!id.prime49,
                // RECURSION: Find children of this specific ID anywhere in the table
                sub_ids: buildIdentifierTree(id.id) 
            }));
    };

    const finalData = persons.map(person => {
        const pId = String(person.id).toLowerCase().trim();
        const myAgents = agents.filter(a => String(a.parent_agent_id || '').toLowerCase().trim() === pId);
        
        if (myAgents.length === 0) return null;

        const companyGroups = {};
        myAgents.forEach(agent => {
            const coMatch = companies.find(c => c.id === agent.company_id);
            const coName = coMatch ? coMatch.company_name : "Independent / No Company";
            
            if (!companyGroups[coName]) companyGroups[coName] = [];

            // Start the tree build from the "root" IDs owned by this agent
            const idTree = buildIdentifierTree(null, agent.id);
            companyGroups[coName].push(...idTree);
        });

        const formattedCompanies = Object.entries(companyGroups)
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
