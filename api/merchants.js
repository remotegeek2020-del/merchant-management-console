import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20, user } = req.body;

    try {
        // --- ACTION: LIST MERCHANTS (With Deep Joins) ---
        if (action === 'list') {
            let dataReq = supabase.from('merchants').select(`
                *,
                agent_identifiers!agent_id (
                    agents ( 
                        companies ( 
                            company_name, 
                            company_person_mapping ( 
                                persons ( full_name ) 
                            ) 
                        ) 
                    )
                )
            `, { count: 'exact' });

            if (statusFilter) dataReq.eq('account_status', statusFilter);
            if (query && filterBy) {
                if (filterBy === 'dba_name') dataReq.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') dataReq.eq('merchant_id', query);
                else if (filterBy === 'agent_id') dataReq.eq('agent_id', query);
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
            
            return res.status(200).json({ 
                success: true, 
                data: dataRes.data,
                count: dataRes.count,
                metrics: { 
                    totalMTD: stats.out_mtd, 
                    total30D: stats.out_30d, 
                    total90D: stats.out_90d, 
                    portfolioShare: stats.out_global_mtd > 0 ? ((stats.out_mtd / stats.out_global_mtd) * 100).toFixed(2) : "0.00" 
                }
            });
        }

        // --- ACTION: UPDATE MERCHANT (Audit Logging) ---
        if (action === 'update') {
            const { data: oldData } = await supabase.from('merchants').select('*').eq('id', id).single();
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

        // --- ACTION: GET NOTES & ATTACHMENTS ---
        if (action === 'get_notes') {
            const { merchant_uuid, type } = req.body;
            let q = supabase.from('merchant_notes').select('*').eq('merchant_id', merchant_uuid);
            if (type === 'manual') q = q.neq('title', 'System Update');
            else if (type === 'system') q = q.eq('title', 'System Update');
            const { data, error } = await q.order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'get_attachments') {
            const { data, error } = await supabase.from('merchant_attachments').select('*').eq('merchant_id', req.body.merchant_uuid).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'save_attachment') {
            const { error } = await supabase.from('merchant_attachments').insert([{ merchant_id: req.body.merchant_uuid, attachment_name: req.body.name, file_url: req.body.url }]);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'add_note') {
            const { error } = await supabase.from('merchant_notes').insert([{ merchant_id: req.body.merchant_uuid, title: req.body.title, body: req.body.body, created_by: req.body.user }]);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
