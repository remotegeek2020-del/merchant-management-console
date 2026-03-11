import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
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

            if (query && filterBy) {
                if (filterBy === 'dba_name') request = request.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') request = request.eq('merchant_id', query);
                else if (filterBy === 'agent_id') request = request.eq('agent_id', query);
                else if (filterBy === 'company_name') request = request.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                else if (filterBy === 'partner_name') request = request.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;

            const simplifiedData = (data || []).map(m => {
                const person = m.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons;
                return {
                    ...m,
                    company_name: m.agent_identifiers?.agents?.companies?.company_name || '---',
                    partner_name: person?.full_name || '---'
                };
            });

            return res.status(200).json({ success: true, data: simplifiedData, count });
        }

        // FIXED: Explicitly handles the payload for account_status updates
        if (action === 'update') {
            const { error } = await supabase
                .from('merchants')
                .update({
                    dba_name: payload.dba_name,
                    account_status: payload.account_status,
                    merchant_primary_contact: payload.merchant_primary_contact,
                    email: payload.email,
                    merchant_phone: payload.merchant_phone,
                    underwriting_decision_note: payload.underwriting_decision_note,
                    // Add other fields from your list as needed here
                })
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
