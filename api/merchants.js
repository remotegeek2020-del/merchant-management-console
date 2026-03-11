import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. DEFINE THE JOIN STRUCTURE
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

            // 2. APPLY INNER JOINS IF SEARCHING BY PARTNER/COMPANY
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // --- QUERY A: TOTAL GLOBAL VOLUME (FOR THE KPI CARD) ---
            // We fetch the volume column for EVERY record matching the filter, ignoring pagination
            let volQuery = supabase.from('merchants').select(`
                volume_mtd,
                agent_identifiers!agent_id (
                    agents (
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
            `);

            // --- QUERY B: TABLE DATA (PAGINATED) ---
            let dataQuery = supabase.from('merchants').select(selectString, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            dataQuery = dataQuery.range(page * pageSize, (page + 1) * pageSize - 1).order('created_at', { ascending: false });

            // 3. APPLY FILTERS TO BOTH QUERIES SIMULTANEOUSLY
            [volQuery, dataQuery].forEach(q => {
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (filterBy === 'company_name') q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            // Execute both queries
            const [{ data: volData }, { data: tableData, count, error }] = await Promise.all([volQuery, dataQuery]);
            
            if (error) throw error;

            // Calculate the true global sum from the volQuery results
            const totalVolumeMTD = (volData || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);

            // Defensive Data Mapping for the table
            const simplifiedData = (tableData || []).map(m => {
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
