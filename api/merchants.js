import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20, user } = req.body;

    try {
        // --- NEW ACTION: check_mids (Supporting the Smart Scan Feature) ---
        if (action === 'check_mids') {
            const { mids } = req.body;
            const { data, error } = await supabase
                .from('merchants')
                .select('merchant_id')
                .in('merchant_id', mids);

            if (error) throw error;
            return res.status(200).json({ 
                success: true, 
                existingMids: data.map(m => String(m.merchant_id)) 
            });
        }

        // --- ENHANCED ACTION: bulk_upsert (Trusting Frontend Field Mapping) ---
        if (action === 'bulk_upsert') {
            const dataToUpsert = payload.filter(item => item.merchant_id);
            try {
                const { error } = await supabase
                    .from('merchants')
                    .upsert(dataToUpsert, { 
                        onConflict: 'merchant_id',
                        ignoreDuplicates: false 
                    });

                if (error) throw error;

                // Log the bulk action for audit purposes
                await supabase.from('merchant_notes').insert([{
                    title: "Bulk Import Success",
                    body: `Synchronized ${dataToUpsert.length} records via mapped CSV uploader.`,
                    created_by: user || 'System'
                }]);

                return res.status(200).json({ success: true, count: dataToUpsert.length });
            } catch (err) {
                console.error("Bulk Upsert Error:", err.message);
                return res.status(500).json({ success: false, message: err.message });
            }
        }

        // --- ORIGINAL ACTION: getMonthlyReport ---
        if (action === 'getMonthlyReport') {
            const { startDate, endDate, offset = 0, limit = 1000 } = req.body;
            let queryBuilder = supabase.from('merchant_portfolio_view')
                .select(`merchant_id, dba_name, agent_id, company_name, partner_full_name, enrollment_date, account_status`, { count: 'exact' })
                .eq('is_prime49', true); 

            if (startDate && endDate) {
                queryBuilder = queryBuilder.gte('enrollment_date', `${startDate}T00:00:00.000Z`).lte('enrollment_date', `${endDate}T23:59:59.999Z`);
            }
            const { data, count, error } = await queryBuilder.range(offset, offset + limit - 1).order('enrollment_date', { ascending: false });
            if (error) return res.status(500).json({ success: false, message: error.message });
            return res.status(200).json({ success: true, rawData: data || [], totalCount: count || 0 });
        }

        // --- ORIGINAL ACTION: get_global_tasks ---
        if (action === 'get_global_tasks') {
            const { userid, targetUser, status } = req.body;
            let queryBuilder = supabase.from('merchant_tasks')
                .select(`*, merchants:merchant_id ( * ), assigned_user:app_users!merchant_tasks_assigned_to_fkey ( first_name, last_name )`, { count: 'exact' });

            if (targetUser) { queryBuilder = queryBuilder.eq('assigned_to', targetUser); } 
            else if (userid) { queryBuilder = queryBuilder.eq('assigned_to', userid); }

            if (status) { queryBuilder = queryBuilder.eq('status', status); }

            const { data, count, error } = await queryBuilder.range(page * limit, (page + 1) * limit - 1).order('due_date', { ascending: true });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [], total: count });
        }

        // --- ORIGINAL ACTION: delete_task ---
        if (action === 'delete_task') {
            const { task_id } = req.body;
            const { error } = await supabase.from('merchant_tasks').delete().eq('id', task_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ORIGINAL ACTION: add_task ---
        if (action === 'add_task') {
            const { merchant_uuid, title, body, due_date, assigned_to, created_by } = req.body;
            const validCreator = (created_by && created_by !== 'System' && created_by !== 'undefined') ? created_by : null;
            const { data, error } = await supabase.from('merchant_tasks').insert([{
                merchant_id: merchant_uuid, title: title, body: body, due_date: due_date || null,
                assigned_to: assigned_to || null, created_by: validCreator, status: 'Pending'
            }]).select();
            if (error) return res.status(400).json({ success: false, message: error.message });
            return res.status(200).json({ success: true, data });
        }

        // --- ORIGINAL ACTION: update_task ---
        if (action === 'update_task') {
            const { task_id, payload } = req.body; 
            const { error } = await supabase.from('merchant_tasks').update({
                title: payload.title, body: payload.body, due_date: payload.due_date,
                assigned_to: payload.assigned_to, status: payload.status 
            }).eq('id', task_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ORIGINAL ACTION: get_staff ---
        if (action === 'get_staff') {
            const { data, error } = await supabase.from('app_users').select('userid, first_name, last_name, email');
            if (error) throw error;
            const formatted = (data || []).map(u => ({ id: u.userid, full_name: `${u.first_name} ${u.last_name || ''}`.trim() }));
            return res.status(200).json({ success: true, data: formatted });
        }
    
        // --- ORIGINAL ACTION: get_tasks ---
        if (action === 'get_tasks') {
            const { merchant_uuid } = req.body;
            const { data, error } = await supabase.from('merchant_tasks')
                .select(`*, assigned_user:app_users!merchant_tasks_assigned_to_fkey ( first_name, last_name, email )`)
                .eq('merchant_id', merchant_uuid).order('due_date', { ascending: true });
            if (error) throw error;
            const tasks = (data || []).map(t => ({ ...t, assignee_name: t.assigned_user ? `${t.assigned_user.first_name} ${t.assigned_user.last_name || ''}`.trim() : 'Unassigned' }));
            return res.status(200).json({ success: true, data: tasks });
        }

        // --- ORIGINAL ACTION: get_merchant_history ---
        if (action === 'get_merchant_history' || action === 'getMerchantHistory') {
            const { merchant_id } = req.body;
            const { data, error } = await supabase.from('equipment_logs')
                .select(`*, equipments:equipment_id (serial_number, terminal_type)`)
                .eq('merchant_id', merchant_id).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        // --- ORIGINAL ACTION: get_merchant_equipment ---
        if (action === 'get_merchant_equipment') {
            const { merchant_uuid } = req.body;
            const { data, error } = await supabase.from('equipments').select('*').eq('merchant_id', merchant_uuid).order('serial_number', { ascending: true });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        // --- ORIGINAL ACTION: attachments logic ---
        if (action === 'add_attachment') {
            const { merchant_id, file_name, file_path, file_type, file_size, uploaded_by } = req.body;
            const { error } = await supabase.from('merchant_attachments').insert([{ merchant_id, file_name, file_path, file_type, file_size, uploaded_by }]);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'get_attachments') {
            const { merchant_uuid } = req.body;
            const { data, error } = await supabase.from('merchant_attachments').select('*').eq('merchant_id', merchant_uuid).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // --- ORIGINAL ACTION: list (Dashboard Table) ---
        if (action === 'list') {
            let dataReq = supabase.from('merchant_portfolio_view').select('*', { count: 'exact' });
            if (statusFilter) dataReq.eq('account_status', statusFilter);
            if (query && filterBy) {
                const colMap = { 'dba_name': 'dba_name', 'merchant_id': 'merchant_id', 'agent_id': 'agent_id', 'company_name': 'company_name', 'partner_name': 'partner_full_name' };
                dataReq.ilike(colMap[filterBy] || filterBy, `%${query}%`);
            }
            const { data, count, error: dataError } = await dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false });
            if (dataError) throw dataError;

            let stats = { out_mtd: 0, out_30d: 0, out_90d: 0 };
            try {
                const { data: mathData } = await supabase.rpc('get_merchant_metrics', { 
                    p_status_filter: statusFilter || null, p_query: query || null, p_filter_by: filterBy === 'partner_name' ? 'partner_full_name' : (filterBy || null)
                });
                if (mathData && mathData[0]) stats = mathData[0];
            } catch (e) { console.error("Metrics skipped"); }

            const formattedData = (data || []).map(m => ({ ...m, partner_name: m.partner_full_name || '---', is_prime49: m.is_prime49 || false }));
            return res.status(200).json({ success: true, data: formattedData, count: count || 0, metrics: { totalMTD: stats.out_mtd || 0, total30D: stats.out_30d || 0, total90D: stats.out_90d || 0, portfolioShare: "0.00" } });
        }

        // --- ORIGINAL ACTION: update (Profile Edit) ---
        if (action === 'update') {
            if (!id) return res.status(400).json({ success: false, message: "Missing Merchant UUID" });
            const { data, error } = await supabase.from('merchants').update(payload).eq('id', id).select();
            if (error) throw error;
            try {
                await supabase.from('merchant_notes').insert([{
                    merchant_id: id, title: "System Update", created_by: user || 'Admin',
                    body: `Manual profile update performed. Fields impacted: ${Object.keys(payload).join(', ')}`
                }]);
            } catch (noteErr) { console.warn("Audit note failed"); }
            return res.status(200).json({ success: true, data });
        }

        // --- ORIGINAL ACTION: notes logic ---
        if (action === 'get_notes') {
            const { merchant_uuid, type } = req.body;
            let q = supabase.from('merchant_notes').select('*').eq('merchant_id', merchant_uuid);
            if (type === 'manual') { q = q.neq('title', 'System Update'); } 
            else if (type === 'system') { q = q.eq('title', 'System Update'); }
            const { data, error } = await q.order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'add_note') {
            const { merchant_uuid, title, body, created_by, userId } = req.body;
            const { error } = await supabase.from('merchant_notes').insert([{ merchant_id: merchant_uuid, title, body, created_by: created_by || userId || 'Staff' }]);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: "Unknown action" });

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
