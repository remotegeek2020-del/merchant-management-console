import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. SELECT STRING SETUP (LOCKED SEARCH LOGIC)
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

            // Apply !inner join IF searching by Company or Partner Name
            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            if (isDeepSearch) {
                selectString = selectString
                    .replace('agent_identifiers!agent_id (', 'agent_identifiers!agent_id !inner (')
                    .replace('agents (', 'agents !inner (')
                    .replace('companies (', 'companies !inner (')
                    .replace('company_person_mapping (', 'company_person_mapping !inner (')
                    .replace('persons (', 'persons !inner (');
            }

            // 2. INITIALIZE REQUESTS
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            let volReq = supabase.from('merchants').select(`volume_mtd, volume_30_day, volume_90_day, account_status, ${selectString.split('*,')[1]}`);
            let absReq = supabase.from('merchants').select('volume_mtd'); // Global for Portfolio Share

            // 3. APPLY COMBINED FILTERS (The "AND" Logic)
            [dataReq, volReq].forEach(q => {
                // A. Apply Status Filter first (if exists)
                if (statusFilter) {
                    q.eq('account_status', statusFilter);
                }

                // B. Apply Search Filter second (if exists)
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (filterBy === 'company_name') {
                        q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    } 
                    else if (filterBy === 'partner_name') {
                        q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                    }
                }
            });

            // 4. EXECUTE ALL QUERIES
            const pageSize = parseInt(limit) || 20;
            const [dataRes, volRes, absRes] = await Promise.all([
                dataReq.range(page * pageSize, (page + 1) * pageSize - 1).order('created_at', { ascending: false }),
                volReq,
                absReq
            ]);

            if (dataRes.error) throw dataRes.error;

            // 5. CALCULATE METRICS (Filtered Set)
            const filteredMTD = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const filtered30 = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_30_day) || 0), 0);
            const filtered90 = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_90_day) || 0), 0);
            
            // 6. PORTFOLIO SHARE (Michelle's Volume vs Entire DB Total)
            const absoluteMTD = (absRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const share = absoluteMTD > 0 ? ((filteredMTD / absoluteMTD) * 100).toFixed(2) : 0;

            // 7. MAPPING FOR DASHBOARD
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
                metrics: { totalMTD: filteredMTD, total30D: filtered30, total90D: filtered90, portfolioShare: share }
            });
        }

        // --- UPDATE ACTION ---
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
