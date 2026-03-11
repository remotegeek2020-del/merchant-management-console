import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, filterBy, page = 0, limit = 15 } = req.body;

    try {
        if (action === 'list') {
            // Updated select string with !inner for filtering joined tables
            let selectString = `
                *,
                agent_identifiers!agent_id !inner (
                    agents !inner (
                        agent_name,
                        companies !inner (
                            company_name,
                            company_person_mapping !inner (
                                persons !inner (
                                    full_name
                                )
                            )
                        )
                    )
                )
            `;

            // If no specific filter is selected, we use the standard left join
            if (!query || !filterBy || filterBy === 'dba_name' || filterBy === 'merchant_id' || filterBy === 'agent_id') {
                selectString = selectString.replace(/!inner/g, ''); 
            }

            let request = supabase.from('merchants').select(selectString, { count: 'exact' });

            request = request.range(page * limit, (page + 1) * limit - 1);
            request = request.order('created_at', { ascending: false });

            // Apply specific filters
            if (query && filterBy) {
                if (filterBy === 'dba_name') request = request.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') request = request.eq('merchant_id', query);
                else if (filterBy === 'agent_id') request = request.eq('agent_id', query);
                else if (filterBy === 'company_name') {
                    request = request.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                } else if (filterBy === 'partner_name') {
                    request = request.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            } else if (query) {
                request = request.or(`dba_name.ilike.%${query}%,merchant_id.ilike.%${query}%,agent_id.ilike.%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;

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
        return res.status(500).json({ success: false, message: err.message });
    }
}
