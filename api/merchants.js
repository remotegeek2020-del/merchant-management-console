import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20, user } = req.body;

    try {
        if (action === 'list') {
            // Querying the VIEW handles the complex joins and type casting automatically
            let dataReq = supabase.from('merchant_portfolio_view').select('*', { count: 'exact' });

            if (statusFilter) dataReq.eq('account_status', statusFilter);
            if (query && filterBy) {
                // If filtering by Company or Partner Name, we use the View's specific column names
                const filterMap = {
                    'dba_name': 'dba_name',
                    'merchant_id': 'merchant_id',
                    'agent_id': 'agent_id',
                    'company_name': 'company_name',
                    'partner_name': 'partner_full_name'
                };
                const column = filterMap[filterBy] || filterBy;
                dataReq.ilike(column, `%${query}%`);
            }

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
            const share = stats.out_global_mtd > 0 ? ((stats.out_mtd / stats.out_global_mtd) * 100).toFixed(2) : "0.00";

            return res.status(200).json({ 
                success: true, 
                data: dataRes.data, // Data is already correctly mapped by the View
                count: dataRes.count,
                metrics: { 
                    totalMTD: stats.out_mtd, 
                    total30D: stats.out_30d, 
                    total90D: stats.out_90d, 
                    portfolioShare: share 
                }
            });
        }

        // --- UPDATE MERCHANT ACTION ---
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- NOTES ACTIONS ---
        if (action === 'get_notes') {
            const { merchant_uuid } = req.body;
            const { data, error } = await supabase.from('merchant_notes').select('*').eq('merchant_id', merchant_uuid).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'add_note') {
            const { error } = await supabase.from('merchant_notes').insert([{ 
                merchant_id: req.body.merchant_uuid, 
                title: req.body.title, 
                body: req.body.body, 
                created_by: user || 'System'
            }]);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
