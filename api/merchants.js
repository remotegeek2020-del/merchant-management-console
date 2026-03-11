import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, page = 0, limit = 15, sortBy = 'created_at' } = req.body;

    try {
        if (action === 'list') {
            // We use a join-heavy select to allow filtering by Partner Name later if needed,
            // though for global text search, Supabase works best on the main table columns.
            let request = supabase
                .from('merchants')
                .select(`
                    *,
                    agent_identifiers!agent_id (
                        id_string,
                        agents (
                            agent_name,
                            companies (
                                company_name,
                                company_person_mapping (
                                    persons (
                                        full_name
                                    )
                                )
                            )
                        )
                    )
                `, { count: 'exact' });

            // Handle Pagination
            request = request.range(page * limit, (page + 1) * limit - 1);

            // Handle Sorting: Recently Created vs Recently Updated
            request = request.order(sortBy, { ascending: false });

            // Handle Advanced Search (DBA, MerchantID, AgentID)
            if (query) {
                request = request.or(`dba_name.ilike.%${query}%,merchant_id.ilike.%${query}%,agent_id.ilike.%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;

            const simplifiedData = data.map(m => {
                const agentInfo = m.agent_identifiers?.agents;
                const companyInfo = agentInfo?.companies;
                const personInfo = companyInfo?.company_person_mapping?.[0]?.persons;

                return {
                    ...m,
                    company_name: companyInfo?.company_name || 'Legacy/Unassigned',
                    partner_name: personInfo?.full_name || 'System',
                    partner_id: m.agent_id // Correlating Partner ID to Agent ID for this view
                };
            });

            return res.status(200).json({ success: true, data: simplifiedData, count });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
