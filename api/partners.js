import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, person_id, id, payload } = body;

    if (!action) return res.status(400).json({ success: false, message: "No action provided" });

    try {
        // --- ACTION: GET PARTNERS LIST (Hybrid Logic) ---
        if (action === 'get_partners_list') {
            const [pRes, mRes, cRes, aRes, iRes] = await Promise.all([
                supabase.from('persons').select('id, full_name'),
                supabase.from('company_person_mapping').select('person_id, company_id'),
                supabase.from('companies').select('id, company_name'),
                supabase.from('agents').select('id, company_id, parent_agent_id'),
                supabase.from('agent_identifiers').select('*') 
            ]);

            const persons = pRes.data || [];
            const mappings = mRes.data || [];
            const companies = cRes.data || [];
            const agents = aRes.data || [];
            const identifiers = iRes.data || [];

            const finalData = persons.map(p => {
                const pId = String(p.id || '').toLowerCase().trim();
                
                // Path 1: Via Company Mapping
                const myCompanyIds = mappings
                    .filter(m => String(m.person_id || '').toLowerCase().trim() === pId)
                    .map(m => String(m.company_id || '').toLowerCase().trim());
                
                // Path 2: Via Direct parent_agent_id Link
                const directAgentIds = agents
                    .filter(a => String(a.parent_agent_id || '').toLowerCase().trim() === pId)
                    .map(a => String(a.id || '').toLowerCase().trim());

                const myCompanies = companies
                    .filter(c => myCompanyIds.includes(String(c.id || '').toLowerCase().trim()))
                    .map(co => {
                        const coId = String(co.id || '').toLowerCase().trim();
                        
                        // Find agents that belong to the company OR belong directly to the person
                        const coAgentUuids = agents
                            .filter(a => 
                                String(a.company_id || '').toLowerCase().trim() === coId || 
                                directAgentIds.includes(String(a.id).toLowerCase().trim())
                            )
                            .map(a => String(a.id || '').toLowerCase().trim());
                        
                        const myIds = identifiers
                            .filter(i => i.agent_id && coAgentUuids.includes(String(i.agent_id).toLowerCase().trim()))
                            .map(id => ({
                                string: id.id_string || "Missing ID",
                                rev: id.rev_share || '0%',
                                isPrime: !!id.prime49,
                                db_id: id.id 
                            }));

                        return { name: co.company_name, ids: myIds };
                    });

                if (myCompanies.length === 0 && directAgentIds.length === 0) return null;
                return { id: p.id, name: p.full_name, companies: myCompanies };
            }).filter(Boolean);

            return res.status(200).json({ success: true, data: finalData });
        }

        // --- ACTION: UPDATE IDENTIFIER (ID Manager) ---
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
            const { data: mappings } = await supabase.from('company_person_mapping').select('company_id').eq('person_id', person_id);
            const coIds = (mappings || []).map(m => m.company_id);
            const { data: masters } = await supabase.from('agents').select('id').in('company_id', coIds);
            const masterAgentIds = (masters || []).map(a => a.id);

            const { data: subAgents, error } = await supabase
                .from('agents')
                .select(`agent_name, agent_identifiers (id_string, rev_share)`)
                .in('parent_agent_id', masterAgentIds);

            if (error) throw error;
            return res.status(200).json({ success: true, data: subAgents || [] });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
