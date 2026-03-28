import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20, user } = req.body;

    try 
    
    
    {

        // --- ACTION: delete_task (api/merchants.js) ---
if (action === 'delete_task') {
    const { task_id } = req.body;

    const { error } = await supabase
        .from('merchant_tasks')
        .delete()
        .eq('id', task_id);

    if (error) throw error;
    return res.status(200).json({ success: true });
}
        // --- ACTION: add_task (api/merchants.js) ---
if (action === 'add_task') {
    const { merchant_uuid, title, body, due_date, assigned_to, created_by } = req.body;

    const { data, error } = await supabase
        .from('merchant_tasks')
        .insert([{
            merchant_id: merchant_uuid, // Must match your SQL column name
            title: title,
            body: body,
            due_date: due_date || null,
            assigned_to: assigned_to || null,
            created_by: created_by || 'System',
            status: 'Pending'
        }])
        .select();

    if (error) {
        console.error("DB Error:", error.message);
        return res.status(200).json({ success: false, message: error.message });
    }

    return res.status(200).json({ success: true, data });
}
        // --- ACTION: update_task (api/merchants.js) ---
if (action === 'update_task') {
    const { task_id, payload } = req.body; // payload contains the fields to change

    const { error } = await supabase
        .from('merchant_tasks')
        .update(payload)
        .eq('id', task_id);

    if (error) throw error;
    return res.status(200).json({ success: true });
}

        if (action === 'get_staff') {
    const { data, error } = await supabase
        .from('app_users')
        .select('userid, first_name, last_name, email');

    if (error) throw error;

    // We MUST map 'userid' to 'id' and create 'full_name' for the frontend to see it
    const formatted = (data || []).map(u => ({
        id: u.userid, 
        full_name: `${u.first_name} ${u.last_name || ''}`.trim()
    }));

    return res.status(200).json({ success: true, data: formatted });
}
    
// --- ACTION: get_tasks (Updated for app_users join) ---
if (action === 'get_tasks') {
    const { merchant_uuid } = req.body;
    
    const { data, error } = await supabase
        .from('merchant_tasks')
        .select(`
            *,
            assigned_user:app_users!merchant_tasks_assigned_to_fkey ( first_name, last_name, email )
        `)
        .eq('merchant_id', merchant_uuid)
        .order('due_date', { ascending: true });

    if (error) throw error;

    // Format for the frontend
    const tasks = (data || []).map(t => ({
        ...t,
        assignee_name: t.assigned_user ? `${t.assigned_user.first_name} ${t.assigned_user.last_name || ''}`.trim() : 'Unassigned'
    }));

    return res.status(200).json({ success: true, data: tasks });
}
// --- ACTION: add_task (api/merchants.js) ---
if (action === 'add_task') {
    const { merchant_uuid, title, body, due_date, assigned_to, created_by } = req.body;

    // We must ensure the column names here match your 'merchant_tasks' table columns
    const { data, error } = await supabase
        .from('merchant_tasks')
        .insert([{
            merchant_id: merchant_uuid,
            title: title,
            body: body,
            due_date: due_date || null,
            assigned_to: assigned_to || null, // This is the userid (TEXT)
            created_by: created_by || 'System',
            status: 'Pending'
        }])
        .select();

    if (error) {
        console.error("Supabase Insert Error:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }

    return res.status(200).json({ success: true, data });
}

        // --- ACTION: bulk_upsert (Create or Update based on merchant_id) ---
if (action === 'bulk_upsert') {
    const dataToUpsert = payload.map(row => ({
        merchant_id: row.merchant_id?.trim(),
        dba_name: row.dba_name,
        status_id: row.status_id,
        agent_name: row.agent_name,
        agent_id: row.agent_id,
        account_status: row.account_status,
        is_edge_enabled: row.is_edge_enabled,
        is_pci_compliant: row.is_pci_compliant,
        isv_commission_code: row.isv_commission_code,
        is_mobile: row.is_mobile,
        is_device_hub_link_enabled: row.is_device_hub_link_enabled,
        enrollment_date: row.enrollment_date,
        approved_date: row.approved_date,
        source: row.source,
        processor: row.processor,
        processor_platform: row.processor_platform,
        is_activated: row.is_activated,
        days_approved: row.days_approved,
        shipping_status: row.shipping_status,
        gateway_account_id: row.gateway_account_id,
        last_batch_date: row.last_batch_date,
        account_status_change_date: row.account_status_change_date,
        account_code: row.account_code,
        ndf: row.ndf,
        irs_tin_status: row.irs_tin_status,
        volume: row.volume,
        volume_30_day: row.volume_30_day,
        volume_90_day: row.volume_90_day,
        volume_mtd: row.volume_mtd,
        credit_review: row.credit_review,
        fresno_buy_rate_tier: row.fresno_buy_rate_tier,
        underwriting_decision_note: row.underwriting_decision_note,
        email: row.email,
        ach_properties: row.ach_properties,
        major_merchant: row.major_merchant,
        merchant_websites: row.merchant_websites,
        merchant_primary_contact: row.merchant_primary_contact,
        merchant_phone: row.merchant_phone
    })).filter(item => item.merchant_id); // Ensure we don't send rows without IDs

    // Supabase Upsert logic: If merchant_id matches an existing record, update it.
    // Otherwise, create a new record.
    const { error } = await supabase
        .from('merchants')
        .upsert(dataToUpsert, { onConflict: 'merchant_id' });

    if (error) throw error;
    return res.status(200).json({ success: true, count: dataToUpsert.length });
}
        if (action === 'get_merchant_history') {
    const { merchant_id } = req.body; // Pulls directly from body

    if (!merchant_id) {
        return res.status(400).json({ success: false, message: "Missing Merchant ID" });
    }

    const { data, error } = await supabase
        .from('equipment_logs')
        .select(`
            *,
            equipments:equipment_id (serial_number, terminal_type)
        `)
        .eq('merchant_id', merchant_id) 
        .order('created_at', { ascending: false });

    if (error) throw error;
    return res.status(200).json({ success: true, data: data || [] });
}
        // --- ACTION: get_merchant_history (MATCHES FRONTEND EXACTLY) ---
if (action === 'get_merchant_history') {
    const { merchant_id } = req.body;

    const { data, error } = await supabase
        .from('equipment_logs')
        .select(`
            *,
            equipments:equipment_id (serial_number, terminal_type)
        `)
        .eq('merchant_id', merchant_id) 
        .order('created_at', { ascending: false });

    if (error) throw error;
    return res.status(200).json({ success: true, data: data || [] });
}

        // --- ACTION: getMerchantHistory in merchants.js ---
if (action === 'getMerchantHistory') {
    const { merchant_id } = req.body;

    // We query equipment_logs, but we need to join with equipments 
    // to see WHAT was returned (Serial, Model)
    const { data, error } = await supabase
        .from('equipment_logs')
        .select(`
            *,
            equipments:equipment_id (serial_number, terminal_type)
        `)
        .eq('merchant_id', merchant_id) // Ensure your logs table has merchant_id
        .order('created_at', { ascending: false });

    if (error) throw error;
    return res.status(200).json({ success: true, data });
}

        // --- ADD THIS ACTION TO YOUR merchants.js ---
if (action === 'get_merchant_equipment') {
    const { merchant_uuid } = req.body;
    const { data, error } = await supabase
        .from('equipments')
        .select('*')
        .eq('merchant_id', merchant_uuid)
        .order('serial_number', { ascending: true });

    if (error) throw error;
    return res.status(200).json({ success: true, data: data || [] });
}
        // --- ACTION: ADD ATTACHMENT RECORD ---
        if (action === 'add_attachment') {
            const { merchant_id, file_name, file_path, file_type, file_size, uploaded_by } = req.body;
            
            const { data, error } = await supabase
                .from('merchant_attachments')
                .insert([{
                    merchant_id,
                    file_name,
                    file_path,
                    file_type,
                    file_size,
                    uploaded_by
                }]);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }
        
        if (action === 'update_note') {
            const { note_id, title, body } = req.body;
            const { error } = await supabase
                .from('merchant_notes')
                .update({ title, body, created_at: new Date() })
                .eq('id', note_id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET ATTACHMENTS ---
        if (action === 'get_attachments') {
            const { merchant_uuid } = req.body;
            const { data, error } = await supabase
                .from('merchant_attachments')
                .select('*')
                .eq('merchant_id', merchant_uuid)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // --- ACTION: DELETE ATTACHMENT ---
        if (action === 'delete_attachment') {
            const { file_id, file_path } = req.body;
            
            // Delete from Storage
            await supabase.storage.from('merchant-files').remove([file_path]);
            
            // Delete from Database
            const { error } = await supabase.from('merchant_attachments').delete().eq('id', file_id);
            
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
    let queryBuilder = supabase
        .from('merchant_notes')
        .select('*') // Simple select to ensure it doesn't fail
        .eq('merchant_id', merchant_uuid);

    if (type === 'manual') {
        queryBuilder = queryBuilder.neq('title', 'System Update');
    } else if (type === 'system') {
        queryBuilder = queryBuilder.eq('title', 'System Update');
    }

    const { data, error } = await queryBuilder.order('created_at', { ascending: false });
    if (error) throw error;
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
