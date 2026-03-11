import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. SELECT STRING (LOCKED SEARCH)
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            
            if (isDeepSearch) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // 2. CREATE THE BASE REQUEST
            let baseRequest = supabase.from('merchants').select(selectString, { count: 'exact' });

            // 3. APPLY FILTERS (ONE TIME ONLY TO ENSURE STABILITY)
            if (statusFilter) baseRequest = baseRequest.eq('account_status', statusFilter);
            if (query && filterBy) {
                if (filterBy === 'dba_name') baseRequest = baseRequest.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') baseRequest = baseRequest.eq('merchant_id', query);
                else if (filterBy === 'agent_id') baseRequest = baseRequest.eq('agent_id', query);
                else if (isDeepSearch) {
                    if (filterBy === 'company_name') baseRequest = baseRequest.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    if (filterBy === 'partner_name') baseRequest = baseRequest.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            }

            // 4. FETCH EVERYTHING MATCHING THE FILTER (NO PAGINATION YET)
            // This is the "Snapshot" that ensures numbers never change
            const { data: allMatched, count, error } = await baseRequest.order('created_at', { ascending: false });
            
            if (error) throw error;

            // 5. CALCULATE TOTALS FROM THE SNAPSHOT
            const totalMTD = allMatched.reduce((s, m) => s + (parseFloat(m.volume_mtd) || 0), 0);
            const total30 = allMatched.reduce((s, m) => s + (parseFloat(m.volume_30_day) || 0), 0);
            const total90 = allMatched.reduce((s, m) => s + (parseFloat(m.volume_90_day) || 0), 0);

            // 6. CALCULATE PORTFOLIO SHARE (%)
            // Get Absolute Total of the whole DB (unfiltered) for comparison
            const { data: globalData } = await supabase.from('merchants').select('volume_mtd');
            const absoluteTotal = (globalData || []).reduce((s, m) => s + (parseFloat(m.volume_mtd) || 0), 0);
            const share = absoluteTotal > 0 ? ((totalMTD / absoluteTotal) * 100).toFixed(2) : 0;

            // 7. MANUALLY PAGINATE THE SNAPSHOT FOR THE TABLE
            const start = page * limit;
            const paginatedData = allMatched.slice(start, start + limit);

            return res.status(200).json({ 
                success: true, 
                data: paginatedData.map(row => ({
                    ...row,
                    company_name: row.agent_identifiers?.agents?.companies?.company_name || '---',
                    partner_name: row.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons?.full_name || '---'
                })),
                count: count,
                metrics: { 
                    totalMTD: totalMTD, 
                    total30D: total30, 
                    total90D: total90, 
                    portfolioShare: share 
                }
            });
        }
    } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
}
