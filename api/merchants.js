import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // Restore the exact join path that was working for Company/Partner search
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

            // THE FIX: Only use strict filtering (!inner) when a specific search is active
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            let request = supabase.from('merchants').select(selectString, { count: 'exact' });

            // Apply specific filters
            if (query && filterBy) {
                if (filterBy === 'dba_name') request = request.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') request = request.eq('merchant_id', query);
                else if (filterBy === 'agent_id') request = request.eq('agent_id', query);
                else if (filterBy === 'company_name') request = request.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                else if (filterBy === 'partner_name') request = request.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
            }

            // Order and Range
            const pageSize = parseInt(limit) || 20;
            request = request.order('created_at', { ascending: false });
            
            // Note: We are fetching the data for the sum before we apply the range
            const { data: allData, count, error } = await request;
            if (error) throw error;

            // Calculate the Total Volume from the filtered result set
            const totalVolumeMTD = (allData || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);

            // Now slice the data for the specific page being viewed
            const start = page * pageSize;
            const paginatedData = allData.slice(start, start + pageSize);

            const simplifiedData = paginatedData.map(m => {
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

        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
