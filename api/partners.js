import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    
    const supabase = createClient(
        process.env.SUPABASE_URL, 
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 1. EXTRACT DATA IMMEDIATELY
    const body = req.body || {};
    const action = body.action;
    const person_id = body.person_id;

    // 2. GUARD CLAUZE
    if (!action) {
        return res.status(400).json({ success: false, message: "No action provided" });
    }

    try {
        // --- ROUTE: GET PARTNERS LIST ---
     // --- ACTION: GET PARTNERS LIST (Aggregated Version) ---
if (action === 'get_partners_list') {
    const [pRes, mRes, cRes, aRes, iRes] = await Promise.all([
        supabase.from('persons').select('id, full_name'),
        supabase.from('company_person_mapping').select('person_id, company_id'),
        supabase.from('companies').select('id, company_name'),
        supabase.from('agents').select('id, company_id'),
        supabase.from('agent_identifiers').select('*') 
    ]);

    const persons = pRes.data || [];
    const mappings = mRes.data || [];
    const companies = cRes.data || [];
    const agents = aRes.data || [];
    const identifiers = iRes.data || [];

    const finalData = persons.map(p => {
        const pId = String(p.id || '').toLowerCase().trim();
        
        const myCompanyIds = mappings
            .filter(m => String(m.person_id || '').toLowerCase().trim() === pId)
            .map(m => String(m.company_id || '').toLowerCase().trim());
        
        const myCompanies = companies
            .filter(c => myCompanyIds.includes(String(c.id || '').toLowerCase().trim()))
            .map(co => {
                const coId = String(co.id || '').toLowerCase().trim();

                // FIX: Collect EVERY agent associated with this company
                const coAgentUuids = agents
                    .filter(a => String(a.company_id || '').toLowerCase().trim() === coId)
                    .map(a => String(a.id || '').toLowerCase().trim());
                
                // FIX: Collect EVERY identifier linked to ANY of those agents
                const myIds = identifiers
                    .filter(i => i.agent_id && coAgentUuids.includes(String(i.agent_id).toLowerCase().trim()))
                    .map(id => ({
                        string: id.id_string || "Missing ID",
                        rev: id.rev_share || '0%',
                        isPrime: !!id.prime49
                    }));

                return { name: co.company_name, ids: myIds };
            });

        if (myCompanies.length === 0) return null;
        return { id: p.id, name: p.full_name, companies: myCompanies };
    }).filter(Boolean);

    return res.status(200).json({ success: true, data: finalData });
}
        // --- ROUTE: GET HIERARCHY ---
        if (action === 'get_hierarchy') {
            if (!person_id) {
                return res.status(400).json({ success: false, message: "person_id is missing" });
            }

            const { data: mappings } = await supabase
                .from('company_person_mapping')
                .select('company_id')
                .eq('person_id', person_id);
            
            const coIds = (mappings || []).map(m => m.company_id);

            const { data: masters } = await supabase
                .from('agents')
                .select('id')
                .in('company_id', coIds);
            
            const masterAgentIds = (masters || []).map(a => a.id);

            const { data: subAgents, error } = await supabase
                .from('agents')
                .select(`
                    agent_name,
                    agent_identifiers (id_string, rev_share)
                `)
                .in('parent_agent_id', masterAgentIds);

            if (error) throw error;

            return res.status(200).json({ success: true, data: subAgents || [] });
        }

        // DEFAULT FOR UNKNOWN ACTIONS
        return res.status(400).json({ success: false, message: `Unknown action: ${action}` });

    } catch (err) {
        console.error("Dashboard API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
