import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, userEmail, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // Simplified select to avoid "Overengineering" errors
            let request = supabase
                .from('merchants')
                .select(`
                    *,
                    agent_identifiers (
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

            const pageSize = parseInt(limit) || 20;
            request = request.range(page * pageSize, (page + 1) * pageSize - 1);
            request = request.order('created_at', { ascending: false });

            // Robust Filtering logic
            if (query && filterBy) {
                if (filterBy === 'dba_name') request = request.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') request = request.eq('merchant_id', query);
                else if (filterBy === 'agent_id') request = request.eq('agent_id', query);
                else if (filterBy === 'company_name') request = request.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                else if (filterBy === 'partner_name') request = request.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
            } else if (query) {
                request = request.or(`dba_name.ilike.%${query}%,merchant_id.ilike.%${query}%,agent_id.ilike.%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;

            const simplifiedData = (data || []).map(m => {
                const agent = m.agent_identifiers?.agents;
                const company = agent?.companies;
                const person = company?.company_person_mapping?.[0]?.persons;

                return {
                    ...m,
                    company_name: company?.company_name || '---',
                    partner_name: person?.full_name || '---'
                };
            });

            return res.status(200).json({ success: true, data: simplifiedData, count });
        }

        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'delete') {
            const { error } = await supabase.from('merchants').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
