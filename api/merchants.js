import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // --- 1. YOUR PERFECT SEARCH LOGIC (LOCKED) ---
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

            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            if (isDeepSearch) {
                selectString = selectString
                    .replace('agent_identifiers!agent_id (', 'agent_identifiers!agent_id !inner (')
                    .replace('agents (', 'agents !inner (')
                    .replace('companies (', 'companies !inner (')
                    .replace('company_person_mapping (', 'company_person_mapping !inner (')
                    .replace('persons (', 'persons !inner (');
            }

            // --- 2. INITIALIZE REQUESTS ---
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            
            // MATH FIX: We only select the columns needed for math to prevent data-heavy timeouts
            let volReq = supabase.from('merchants').select(`volume_mtd, volume_30_day, volume_90_day, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`);
            if (isDeepSearch) {
                volReq = volReq.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            let absReq = supabase.from('merchants').select('volume_mtd'); // Global total for Share

            // --- 3. APPLY FILTERS (SEARCH + STATUS) ---
            [dataReq, volReq].forEach(q => {
                if (statusFilter) q.eq('account_status', statusFilter);
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (filterBy === 'company_name') q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            // --- 4. EXECUTE ---
            const pageSize = parseInt(limit) || 20;
            const [dataRes, volRes, absRes] = await Promise.all([
                dataReq.range(page * pageSize, (page + 1) * pageSize - 1).order('created_at', { ascending: false }),
                volReq,
                absReq
            ]);

            if (dataRes.error) throw dataRes.error;

            // --- 5. CALCULATE METRICS (STABLE MATH) ---
            // Use parseFloat and handle nulls to ensure the sum never breaks
            const metricsData = volRes.data || [];
            const filteredMTD = metricsData.reduce((sum, m) => sum + (Number(m.volume_mtd) || 0), 0);
            const filtered30 = metricsData.reduce((sum, m) => sum + (Number(m.volume_30_day) || 0), 0);
            const filtered90 = metricsData.reduce((sum, m) => sum + (Number(m.volume_90_day) || 0), 0);
            
            // Portfolio Share logic
            const absoluteMTD = (absRes.data || []).reduce((sum, m) => sum + (Number(m.volume_mtd) || 0), 0);
            const share = absoluteMTD > 0 ? ((filteredMTD / absoluteMTD) * 100).toFixed(2) : 0;

            // --- 6. MAPPING ---
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
                    total30D: filtered30, 
                    total90D: filtered90, 
                    portfolioShare: share 
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
