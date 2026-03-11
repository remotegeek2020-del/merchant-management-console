import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    // Vercel automatically injects these from your Environment Variables
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, page = 0 } = req.body;
    const PAGE_SIZE = 15;

    try {
        if (action === 'list') {
            let request = supabase
                .from('merchants')
                .select(`
                    *,
                    agent_identifiers!agent_id (
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
                `, { count: 'exact' })
                .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
                .order('created_at', { ascending: false });

            if (query) {
                request = request.or(`dba_name.ilike.%${query}%,agent_id.ilike.%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;

            // Simplify the nested join data for the frontend table
            const simplifiedData = data.map(m => {
                const agentInfo = m.agent_identifiers?.agents;
                const companyInfo = agentInfo?.companies;
                const personInfo = companyInfo?.company_person_mapping?.[0]?.persons;

                return {
                    ...m,
                    company_name: companyInfo?.company_name || 'Legacy/Unassigned',
                    partner_name: personInfo?.full_name || 'System'
                };
            });

            return res.status(200).json({ success: true, data: simplifiedData, count });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
