import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    // Vercel Environment Variables
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, userEmail, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        // --- ACTION: LIST & SUMMARY ---
        if (action === 'list') {
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

            // Force !inner join only when searching by joined tables to prevent page crashes
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString
                    .replace('agent_identifiers!agent_id (', 'agent_identifiers!agent_id !inner (')
                    .replace('agents (', 'agents !inner (')
                    .replace('companies (', 'companies !inner (')
                    .replace('company_person_mapping (', 'company_person_mapping !inner (')
                    .replace('persons (', 'persons !inner (');
            }

            let request = supabase.from('merchants').select(selectString, { count: 'exact' });

            const pageSize = parseInt(limit) || 20;
            request = request.range(page * pageSize, (page + 1) * pageSize - 1);
            request = request.order('created_at', { ascending: false });

            // Apply Filters
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

            // Calculate Summary Metric: Total MTD Volume for the current filtered view
            const totalVolumeMTD = (data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);

            // Defensive Data Mapping
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

            return res.status(200).json({ 
                success: true, 
                data: simplifiedData, 
                count: count,
                totalVolumeMTD: totalVolumeMTD 
            });
        }

        // --- ACTION: UPDATE ---
        if (action === 'update') {
            const { error } = await supabase
                .from('merchants')
                .update(payload)
                .eq('id', id);

            if (error) throw error;

            // Optional: Log to activity_logs
            await supabase.from('activity_logs').insert([{
                email: userEmail || 'System',
                action: `Updated Merchant: ${payload.dba_name || id}`,
                status: 'SUCCESS'
            }]);

            return res.status(200).json({ success: true });
        }

        // --- ACTION: DELETE ---
        if (action === 'delete') {
            const { error } = await supabase
                .from('merchants')
                .delete()
                .eq('id', id);

            if (error) throw error;

            return res.status(200).json({ success: true });
        }

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
