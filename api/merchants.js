import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, filterBy, page = 0, limit = 15 } = req.body;

    try {
        if (action === 'list') {
            // Updated select string with !inner for strict filtering on joins
            let selectString = `
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
            `;

            // Apply !inner only if searching by joined fields
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
                selectString = selectString.replace(/agents \(/g, 'agents !inner (');
                selectString = selectString.replace(/companies \(/g, 'companies !inner (');
                selectString = selectString.replace(/company_person_mapping \(/g, 'company_person_mapping !inner (');
                selectString = selectString.replace(/persons \(/g, 'persons !inner (');
            }

            let request = supabase.from('merchants').select(selectString, { count: 'exact' });

            // Dynamic Range based on user-selected limit
            const pageSize = parseInt(limit);
            request = request.range(page * pageSize, (page + 1) * pageSize - 1);
            request = request.order('created_at', { ascending: false });

            if (query && filterBy) {
                if (filterBy === 'dba_name') request = request.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') request = request.eq('merchant_id', query);
                else if (filterBy === 'agent_id') request = request.eq('agent_id', query);
                else if (filterBy === 'company_name') {
                    request = request.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                } else if (filterBy === 'partner_name') {
                    request = request.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            }

            const { data, count, error } = await request;
            if (error) throw error;

            const simplifiedData = (data || []).map(m => {
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
