import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    // Vercel Environment Variables
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, filterBy, page = 0, limit = 15, sortBy = 'created_at' } = req.body;

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
                `, { count: 'exact' });

            request = request.range(page * limit, (page + 1) * limit - 1);
            request = request.order(sortBy, { ascending: false });

            // Targeted Filters
            if (query && filterBy) {
                if (filterBy === 'dba_name') request = request.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') request = request.eq('merchant_id', query);
                else if (filterBy === 'agent_id') request = request.eq('agent_id', query);
                else if (filterBy === 'partner_name') {
                    request = request.filter('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', 'ilike', `%${query}%`);
                }
            } else if (query) {
                request = request.or(`dba_name.ilike.%${query}%,merchant_id.ilike.%${query}%,agent_id.ilike.%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;

            // Defensive mapping to prevent blank page crashes
            const simplifiedData = data.map(m => {
                const agent = m.agent_identifiers?.agents;
                const company = agent?.companies;
                const person = company?.company_person_mapping?.[0]?.persons;

                return {
                    ...m,
                    company_name: company?.company_name || 'Unassigned',
                    partner_name: person?.full_name || 'System'
                };
            });

            return res.status(200).json({ success: true, data: simplifiedData, count });
        }
    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
