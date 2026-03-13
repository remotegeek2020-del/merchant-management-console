import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // We query the VIEW. If the SQL View was created successfully, this will work.
            let dataReq = supabase.from('merchant_portfolio_view').select('*', { count: 'exact' });

            // Apply Filters
            if (statusFilter) dataReq.eq('account_status', statusFilter);
            if (query && filterBy) {
                // Map the frontend filter names to the VIEW column names
                const colMap = {
                    'dba_name': 'dba_name',
                    'merchant_id': 'merchant_id',
                    'agent_id': 'agent_id',
                    'company_name': 'company_name',
                    'partner_name': 'partner_full_name' // Matches the View
                };
                const targetCol = colMap[filterBy] || filterBy;
                dataReq.ilike(targetCol, `%${query}%`);
            }

            // Fetch Data and Metrics
            const [dataRes, mathRes] = await Promise.all([
                dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
                supabase.rpc('get_merchant_metrics', { 
                    p_status_filter: statusFilter || null, 
                    p_query: query || null, 
                    p_filter_by: filterBy || null 
                })
            ]);

            if (dataRes.error) throw dataRes.error;

            const stats = mathRes.data?.[0] || { out_mtd: 0, out_30d: 0, out_90d: 0, out_global_mtd: 0 };

            return res.status(200).json({ 
                success: true, 
                data: dataRes.data || [],
                count: dataRes.count || 0,
                metrics: { 
                    totalMTD: stats.out_mtd || 0, 
                    total30D: stats.out_30d || 0, 
                    total90D: stats.out_90d || 0, 
                    portfolioShare: stats.out_global_mtd > 0 ? ((stats.out_mtd / stats.out_global_mtd) * 100).toFixed(2) : "0.00" 
                }
            });
        }

        // --- Standard Merchant Update ---
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
