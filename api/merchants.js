import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. SELECT STRING SETUP
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // 2. DATA & VOLUME REQUESTS
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            let volReq = supabase.from('merchants').select(`volume_mtd, volume_30_day, volume_90_day, account_status, ${selectString.split('*,')[1]}`);
            let absReq = supabase.from('merchants').select('volume_mtd').eq('account_status', 'Approved');

            // 3. APPLY FILTERS (Search + Status)
            [dataReq, volReq].forEach(q => {
                // Apply Search Filter
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (filterBy === 'company_name') q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
                // Apply Status Filter (The new requirement)
                if (statusFilter) {
                    q.eq('account_status', statusFilter);
                }
            });

            const [dataRes, volRes, absRes] = await Promise.all([
                dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
                volReq,
                absReq
            ]);

            if (dataRes.error) throw dataRes.error;

            // 4. CALCULATE SUMS
            const filteredMTD = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const filtered30 = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_30_day) || 0), 0);
            const filtered90 = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_90_day) || 0), 0);
            
            // 5. PORTFOLIO SHARE (Michelle's Approved Volume vs Total Approved Volume)
            const absoluteMTD = (absRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const portfolioShare = absoluteMTD > 0 ? ((filteredMTD / absoluteMTD) * 100).toFixed(2) : 0;

            const simplifiedData = (dataRes.data || []).map(m => {
                const person = m.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons;
                return {
                    ...m,
                    company_name: m.agent_identifiers?.agents?.companies?.company_name || '---',
                    partner_name: person?.full_name || '---'
                };
            });

            return res.status(200).json({ 
                success: true, 
                data: simplifiedData, 
                count: dataRes.count,
                metrics: { totalMTD: filteredMTD, total30D: filtered30, total90D: filtered90, portfolioShare }
            });
        }
        // ... update logic
    } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
}
