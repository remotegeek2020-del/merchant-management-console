import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. SELECT STRING (LOCKED SEARCH)
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

            // 2. DATA REQUEST (PAGINATED)
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            
            // 3. FILTERED VOLUME REQUEST (Summing just the filtered set)
            let volReq = supabase.from('merchants').select('volume_mtd, volume_30_day, volume_90_day', { count: 'exact' });

            // 4. APPLY FILTERS TO BOTH
            [dataReq, volReq].forEach(q => {
                if (statusFilter) q.eq('account_status', statusFilter);
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (isDeepSearch) {
                        if (filterBy === 'company_name') q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                        if (filterBy === 'partner_name') q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                    }
                }
            });

            // 5. THE GLOBAL TOTAL (Using a direct sum query to prevent crashes)
            // We only need the total MTD of the whole database to calculate the %
            const { data: globalSumData } = await supabase.rpc('get_total_volume_mtd'); 
            
            // IF YOU DON'T HAVE THE RPC SET UP: 
            // Let's use a standard select but keep it ultra-light
            const { data: absData } = await supabase.from('merchants').select('volume_mtd');

            const [dataRes, volRes] = await Promise.all([
                dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
                volReq
            ]);

            if (dataRes.error) throw dataRes.error;

            // 6. CALCULATE STABLE METRICS
            const m = volRes.data || [];
            const filteredMTD = m.reduce((s, x) => s + (Number(x.volume_mtd) || 0), 0);
            const filtered30 = m.reduce((s, x) => s + (Number(x.volume_30_day) || 0), 0);
            const filtered90 = m.reduce((s, x) => s + (Number(x.volume_90_day) || 0), 0);
            
            const absoluteMTD = (absData || []).reduce((s, x) => s + (Number(x.volume_mtd) || 0), 0);
            const share = absoluteMTD > 0 ? ((filteredMTD / absoluteMTD) * 100).toFixed(2) : 0;

            return res.status(200).json({ 
                success: true, 
                data: (dataRes.data || []).map(row => ({
                    ...row,
                    company_name: row.agent_identifiers?.agents?.companies?.company_name || '---',
                    partner_name: row.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons?.full_name || '---'
                })),
                count: dataRes.count,
                metrics: { 
                    totalMTD: filteredMTD, 
                    total30D: filtered30, 
                    total90D: filtered90, 
                    portfolioShare: share 
                }
            });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
