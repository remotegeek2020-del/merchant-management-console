import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20, user } = req.body;

    try {
        // --- ACTION: LIST (MERGED WITH VIEW LOGIC) ---
        if (action === 'list') {
            let dataReq = supabase.from('merchant_portfolio_view').select('*', { count: 'exact' });

            if (statusFilter) dataReq = dataReq.eq('account_status', statusFilter);

            if (query && filterBy) {
                const colMap = {
                    'dba_name': 'dba_name',
                    'merchant_id': 'merchant_id',
                    'agent_id': 'agent_id',
                    'company_name': 'company_name',
                    'partner_name': 'partner_full_name'
                };
                const targetCol = colMap[filterBy] || filterBy;
                dataReq = dataReq.ilike(targetCol, `%${query}%`);
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
            
            // Map the data so the UI sees 'company_name' and 'partner_name' even if joins are null
            const formattedData = (dataRes.data || []).map(m => ({
                ...m,
                company_name: m.company_name || m.agent_name || '---',
                partner_name: m.partner_full_name || m.agent_name || '---'
            }));

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

        // --- ACTION: UPDATE MERCHANT WITH DETAILED AUDIT LOGGING ---
        if (action === 'update') {
            const { data: oldData, error: fetchError } = await supabase
                .from('merchants')
                .select('*')
                .eq('id', id)
                .single();

            if (fetchError) throw fetchError;

            let changes = [];
            for (let key in payload) {
                let oldVal = oldData[key] ? String(oldData[key]).trim() : "empty";
                let newVal = payload[key] ? String(payload[key]).trim() : "empty";

                if (oldVal !== newVal) {
                    const label = key.replace(/_/g, ' ').toUpperCase();
                    changes.push(`${label}: "${oldVal}" → "${newVal}"`);
                }
            }

            const { error: updateError } = await supabase.from('merchants').update(payload).eq('id', id);
            if (updateError) throw updateError;

            if (changes.length > 0) {
                await supabase.from('merchant_notes').insert([{
                    merchant_id: id,
                    title: "System Update",
                    body: `Field Changes:\n${changes.join('\n')}`,
                    created_by: user || 'System'
                }]);
            }

            return res.status(200).json({ success: true });
        }

        // --- ACTION: GLOBAL ACTIVITY LOGS ---
        if (action === 'global_logs') {
            const { data, error } = await supabase
                .from('merchant_notes')
                .select(`*, merchants(dba_name)`)
                .order('created_at', { ascending: false })
                .limit(100);

            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // --- NOTE ACTIONS (MANUAL & SYSTEM) ---
        if (action === 'get_notes') {
            const { merchant_uuid, type } = req.body;
            let queryBuilder = supabase.from('merchant_notes').select('*').eq('merchant_id', merchant_uuid);

            if (type === 'manual') {
                queryBuilder = queryBuilder.neq('title', 'System Update');
            } else if (type === 'system') {
                queryBuilder = queryBuilder.eq('title', 'System Update');
            }

            const { data, error } = await queryBuilder.order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'add_note') {
            const { error } = await supabase.from('merchant_notes').insert([{ 
                merchant_id: req.body.merchant_uuid, 
                title: req.body.title, 
                body: req.body.body, 
                created_by: req.body.user 
            }]);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
