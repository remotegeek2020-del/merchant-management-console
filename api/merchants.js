import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // We grab merchants and a flat list of agents to match manually
            let dataReq = supabase.from('merchants').select('*', { count: 'exact' });

            if (statusFilter) dataReq.eq('account_status', statusFilter);
            if (query && filterBy) {
                if (filterBy === 'dba_name') dataReq.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') dataReq.eq('merchant_id', query);
                else if (filterBy === 'agent_id') dataReq.eq('agent_id', query);
            }

            const [dataRes, agentsRes, mathRes] = await Promise.all([
                dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
                supabase.from('agents').select('*, companies(company_name)'),
                supabase.rpc('get_merchant_metrics', { 
                    p_status_filter: statusFilter || null, 
                    p_query: query || null, 
                    p_filter_by: filterBy || null 
                })
            ]);

            if (dataRes.error) throw dataRes.error;

            // MANUAL MAPPING: We match the agent by name since IDs are mismatched types
            const formattedData = (dataRes.data || []).map(m => {
                const matchedAgent = agentsRes.data?.find(a => a.full_name === m.agent_name);
                return {
                    ...m,
                    company_name: matchedAgent?.companies?.company_name || m.agent_name || '---',
                    partner_name: matchedAgent?.full_name || '---'
                };
            });

            const stats = mathRes.data?.[0] || { out_mtd: 0, out_30d: 0, out_90d: 0, out_global_mtd: 0 };

            return res.status(200).json({ 
                success: true, 
                data: formattedData,
                count: dataRes.count,
                metrics: { 
                    totalMTD: stats.out_mtd, 
                    total30D: stats.out_30d, 
                    total90D: stats.out_90d, 
                    portfolioShare: stats.out_global_mtd > 0 ? ((stats.out_mtd / stats.out_global_mtd) * 100).toFixed(2) : "0.00" 
                }
            });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
