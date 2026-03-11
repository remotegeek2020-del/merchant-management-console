import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, userEmail, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
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

            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString
                    .replace('agent_identifiers!agent_id (', 'agent_identifiers!agent_id !inner (')
                    .replace('agents (', 'agents !inner (')
                    .replace('companies (', 'companies !inner (')
                    .replace('company_person_mapping (', 'company_person_mapping !inner (')
                    .replace('persons (', 'persons !inner (');
            }

            // --- QUERY A: PAGINATED TABLE DATA ---
            let dataRequest = supabase.from('merchants').select(selectString, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            dataRequest = dataRequest.range(page * pageSize, (page + 1) * pageSize - 1).order('created_at', { ascending: false });

            // --- QUERY B: FILTERED GLOBAL VOLUME (FOR KPI CARDS) ---
            let volRequest = supabase.from('merchants').select('volume_mtd, volume_30_day, volume_90_day, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )');

            // --- QUERY C: ABSOLUTE TOTAL VOLUME (FOR PERCENTAGE CALCULATION) ---
            let absoluteRequest = supabase.from('merchants').select('volume_mtd');

            // Apply Filters to Data and Filtered Volume queries
            [dataRequest, volRequest].forEach(reqObj => {
                if (query && filterBy) {
                    if (filterBy === 'dba_name') reqObj.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') reqObj.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') reqObj.eq('agent_id', query);
                    else if (filterBy === 'company_name') reqObj.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') reqObj.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            const [dataRes, volRes, absRes] = await Promise.all([dataRequest, volRequest, absoluteRequest]);
            
            if (dataRes.error) throw dataRes.error;

            // Calculate Metrics for Filtered Set
            const filteredMTD = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const filtered30D = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_30_day) || 0), 0);
            const filtered90D = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_90_day) || 0), 0);

            // Calculate Global Percentage (Filtered MTD vs Absolute Database MTD)
            const absoluteMTD = (absRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const portfolioPercentage = absoluteMTD > 0 ? ((filteredMTD / absoluteMTD) * 100).toFixed(2) : 0;

            const simplifiedData = (dataRes.data || []).map(m => {
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
                count: dataRes.count,
                metrics: {
                    totalMTD: filteredMTD,
                    total30D: filtered30D,
                    total90D: filtered90D,
                    portfolioShare: portfolioPercentage
                }
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
