import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. DATA REQUEST (Fast & Paginated)
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            
            if (isDeepSearch) {
                const inner = (str) => str.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (')
                                          .replace(/agents \(/g, 'agents !inner (')
                                          .replace(/companies \(/g, 'companies !inner (')
                                          .replace(/company_person_mapping \(/g, 'company_person_mapping !inner (')
                                          .replace(/persons \(/g, 'persons !inner (');
                selectString = inner(selectString);
            }

            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });

            if (statusFilter) dataReq.eq('account_status', statusFilter);
            if (query && filterBy) {
                if (filterBy === 'dba_name') dataReq.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') dataReq.eq('merchant_id', query);
                else if (filterBy === 'agent_id') dataReq.eq('agent_id', query);
                else if (filterBy === 'company_name') dataReq.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                else if (filterBy === 'partner_name') dataReq.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
            }

            // 2. EXECUTE DATA & STATS IN PARALLEL
            // We use the RPC for math because it handles 400k rows instantly
            const [dataRes, statsRes] = await Promise.all([
                dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
                supabase.rpc('get_merchant_stats', { 
                    p_status_filter: statusFilter || null, 
                    p_query: query || null, 
                    p_filter_by: filterBy || null 
                })
            ]);

            if (dataRes.error) throw dataRes.error;
            
            const stats = statsRes.data?.[0] || { total_mtd: 0, total_30d: 0, total_90d: 0, absolute_total_mtd: 0 };
            const share = stats.absolute_total_mtd > 0 ? ((stats.total_mtd / stats.absolute_total_mtd) * 100).toFixed(2) : 0;

            return res.status(200).json({ 
                success: true, 
                data: (dataRes.data || []).map(m => ({
                    ...m,
                    company_name: m.agent_identifiers?.agents?.companies?.company_name || '---',
                    partner_name: m.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons?.full_name || '---'
                })),
                count: dataRes.count,
                metrics: { 
                    totalMTD: stats.total_mtd, 
                    total30D: stats.total_30d, 
                    total90D: stats.total_90d, 
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
