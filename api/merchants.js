import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20, user } = req.body;

    try {
        if (action === 'update_note') {
            const { note_id, title, body } = req.body;
            const { error } = await supabase
                .from('merchant_notes')
                .update({ title, body, created_at: new Date() })
                .eq('id', note_id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'list') {
            const dataReq = supabase
                .from('merchant_portfolio_view')
                .select('*', { count: 'exact' });

            if (statusFilter) dataReq.eq('account_status', statusFilter);

            if (query && filterBy) {
                const colMap = {
                    'dba_name': 'dba_name',
                    'merchant_id': 'merchant_id',
                    'agent_id': 'agent_id',
                    'company_name': 'company_name',
                    'partner_name': 'partner_full_name'
                };
                const targetCol = colMap[filterBy] || filterBy;
                dataReq.ilike(targetCol, `%${query}%`);
            }

            const { data, count, error: dataError } = await dataReq
                .range(page * limit, (page + 1) * limit - 1)
                .order('created_at', { ascending: false });

            if (dataError) throw dataError;

            let stats = { out_mtd: 0, out_30d: 0, out_90d: 0, out_global_mtd: 0 };
            try {
                const { data: mathData } = await supabase.rpc('get_merchant_metrics', { 
                    p_status_filter: statusFilter || null, 
                    p_query: query || null, 
                    p_filter_by: filterBy || null 
                });
                if (mathData && mathData[0]) stats = mathData[0];
            } catch (rpcErr) {
                console.error("Metrics RPC Failed, but continuing...", rpcErr);
            }

            const formattedData = (data || []).map(m => ({
                ...m,
                company_name: m.company_name || m.agent_name || '---',
                partner_name: m.partner_full_name || m.agent_name || '---'
            }));

            return res.status(200).json({ 
                success: true, 
                data: formattedData,
                count: count || 0,
                metrics: { 
                    totalMTD: stats.out_mtd || 0, 
                    total30D: stats.out_30d || 0, 
                    total90D: stats.out_90d || 0, 
                    portfolioShare: stats.out_global_mtd > 0 ? ((stats.out_mtd / stats.out_global_mtd) * 100).toFixed(2) : "0.00" 
                }
            });
        }

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

        if (action === 'global_logs') {
            const { data, error } = await supabase
                .from('merchant_notes')
                .select(`*, merchants(dba_name)`)
                .order('created_at', { ascending: false })
                .limit(100);

            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

     if (action === 'get_notes') {
    const { merchant_uuid, type } = req.body;
    
    // We remove the app_users join to ensure the query actually runs
    let queryBuilder = supabase
        .from('merchant_notes')
        .select('*') 
        .eq('merchant_id', merchant_uuid);

    if (type === 'manual') {
        queryBuilder = queryBuilder.neq('title', 'System Update');
    } else if (type === 'system') {
        queryBuilder = queryBuilder.eq('title', 'System Update');
    }

    const { data, error } = await queryBuilder.order('created_at', { ascending: false });
    
    if (error) throw error;

    // We send the data back as-is. We will handle the "Staff" vs "Name" logic in the frontend.
    return res.status(200).json({ success: true, data: data || [] });
}

        if (action === 'add_note') {
            const { merchant_uuid, title, body, created_by, userId } = req.body;
            const { error } = await supabase
                .from('merchant_notes')
                .insert([{ 
                    merchant_id: merchant_uuid, 
                    title: title, 
                    body: body, 
                    created_by: created_by || userId || 'Staff' 
                }]);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: "Unknown action" });

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
