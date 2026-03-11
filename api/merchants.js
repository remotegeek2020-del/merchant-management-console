import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. YOUR LOCKED SEARCH LOGIC
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            
            if (isDeepSearch) {
                selectString = selectString
                    .replace('agent_identifiers!agent_id (', 'agent_identifiers!agent_id !inner (')
                    .replace('agents (', 'agents !inner (')
                    .replace('companies (', 'companies !inner (')
                    .replace('company_person_mapping (', 'company_person_mapping !inner (')
                    .replace('persons (', 'persons !inner (');
            }

            // 2. THE BASE REQUEST
            let request = supabase.from('merchants').select(selectString, { count: 'exact' });

            // 3. APPLY FILTERS (Search + Status)
            if (statusFilter) request = request.eq('account_status', statusFilter);
            if (query && filterBy) {
                if (filterBy === 'dba_name') request = request.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') request = request.eq('merchant_id', query);
                else if (filterBy === 'agent_id') request = request.eq('agent_id', query);
                else if (isDeepSearch) {
                    if (filterBy === 'company_name') request = request.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    if (filterBy === 'partner_name') request = request.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            }

            // 4. FETCH EVERY MATCHING RECORD (THE SNAPSHOT)
            // We order by created_at to keep the table consistent
            const { data: allMatched, count, error } = await request.order('created_at', { ascending: false });
            
            if (error) throw error;

            // 5. STEADY MATH (Calculated from the snapshot)
            const totalMTD = (allMatched || []).reduce((s, m) => s + (parseFloat(m.volume_mtd) || 0), 0);
            const total30 = (allMatched || []).reduce((s, m) => s + (parseFloat(m.volume_30_day) || 0), 0);
            const total90 = (allMatched || []).reduce((s, m) => s + (parseFloat(m.volume_90_day) || 0), 0);

            // 6. PORTFOLIO SHARE (Michelle's Volume vs Absolute Total)
            // We do a very quick fetch for the global total
            const { data: globalData } = await supabase.from('merchants').select('volume_mtd');
            const absoluteTotal = (globalData || []).reduce((s, m) => s + (parseFloat(m.volume_mtd) || 0), 0);
            const share = absoluteTotal > 0 ? ((totalMTD / absoluteTotal) * 100).toFixed(2) : 0;

            // 7. PAGINATE THE SNAPSHOT FOR THE TABLE
            const pageSize = parseInt(limit) || 20;
            const start = page * pageSize;
            const paginatedData = (allMatched || []).slice(start, start + pageSize);

            // 8. MAP TO CLEAN DATA
            const finalData = paginatedData.map(row => {
                const agent = row.agent_identifiers?.agents;
                const company = agent?.companies;
                const person = company?.company_person_mapping?.[0]?.persons;
                return {
                    ...row,
                    company_name: company?.company_name || '---',
                    partner_name: person?.full_name || '---'
                };
            });

            return res.status(200).json({ 
                success: true, 
                data: finalData, 
                count: count,
                metrics: { totalMTD, total30D: total3, total90D: total90, portfolioShare: share }
            });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
