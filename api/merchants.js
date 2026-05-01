import { createClient } from '@supabase/supabase-js'

// Increase body size limit to 50MB for large CSV bulk uploads
export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20, user } = req.body;
    
    try 
    
    
    {

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
       if (action === 'getMonthlyReport') {
    const { startDate, endDate, offset = 0, limit = 1000 } = req.body;

    let queryBuilder = supabase
        .from('merchant_portfolio_view')
        .select(`
            merchant_id, 
            dba_name, 
            agent_id, 
            company_name, 
            partner_full_name, 
            enrollment_date, 
            account_status
        `, { count: 'exact' })
        .eq('is_prime49', true); 

    if (startDate && endDate) {
        queryBuilder = queryBuilder
            .gte('enrollment_date', `${startDate}T00:00:00.000Z`)
            .lte('enrollment_date', `${endDate}T23:59:59.999Z`);
    }

    const { data, count, error } = await queryBuilder
        .range(offset, offset + limit - 1)
        .order('enrollment_date', { ascending: false });

    if (error) return res.status(500).json({ success: false, message: error.message });

    return res.status(200).json({ 
        success: true, 
        rawData: data || [], 
        totalCount: count || 0 
    });
}
  if (action === 'get_global_tasks') {
    const { userid, targetUser, status, page = 0, limit = 20 } = req.body;
    
    // We start a query on merchant_tasks and join the merchants table
    let queryBuilder = supabase
        .from('merchant_tasks')
        .select(`
            *,
            merchants:merchant_id ( * ),
            assigned_user:app_users!merchant_tasks_assigned_to_fkey ( first_name, last_name )
        `, { count: 'exact' });

    // PRIORITY FILTER: If a specific user is selected in the dropdown
    if (targetUser) {
        queryBuilder = queryBuilder.eq('assigned_to', targetUser);
    } 
    // FALLBACK: If no filter is selected, show only tasks for the logged-in user
    else if (userid) {
        queryBuilder = queryBuilder.eq('assigned_to', userid);
    }

    // Apply Status Filter (Pending/Completed)
    if (status) {
        queryBuilder = queryBuilder.eq('status', status);
    }

    const { data, count, error } = await queryBuilder
        .range(page * limit, (page + 1) * limit - 1)
        .order('due_date', { ascending: true });

    if (error) throw error;

    return res.status(200).json({ 
        success: true, 
        data: data || [], 
        total: count 
    });
}
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

    // --- CRITICAL FIX ---
    // If created_by is missing, 'System', or 'undefined', set it to null.
    // A null value bypasses the Foreign Key check, whereas 'System' triggers a violation.
    const validCreator = (created_by && created_by !== 'System' && created_by !== 'undefined') 
        ? created_by 
        : null;

    const { data, error } = await supabase
        .from('merchant_tasks')
        .insert([{
            merchant_id: merchant_uuid,
            title: title,
            body: body,
            due_date: due_date || null,
            assigned_to: assigned_to || null,
            created_by: validCreator, // Use the sanitized variable
            status: 'Pending'
        }])
        .select();

    if (error) {
        console.error("DB Error:", error.message);
        // Returning 400 or 500 is better for failures so the frontend 'catch' block triggers
        return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(200).json({ success: true, data });
}
    
        // --- ACTION: update_task_status ---
if (action === 'update_task_status') {
    const { task_id } = req.body;

    // Fetch current status first
    const { data: task } = await supabase
        .from('merchant_tasks')
        .select('status')
        .eq('id', task_id)
        .single();

    const newStatus = task?.status === 'Completed' ? 'Pending' : 'Completed';

    const { error } = await supabase
        .from('merchant_tasks')
        .update({ status: newStatus })
        .eq('id', task_id);

    if (error) throw error;
    return res.status(200).json({ success: true, status: newStatus });
}

        // --- ACTION: update_task (api/merchants.js) ---
if (action === 'update_task') {
    const { task_id, payload } = req.body; 

    const { error } = await supabase
        .from('merchant_tasks')
        .update({
            title: payload.title,
            body: payload.body,
            due_date: payload.due_date,
            assigned_to: payload.assigned_to,
            status: payload.status // "Completed" or "Pending"
        })
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


     // --- UPDATED ACTION: bulk_upsert ---
if (action === 'bulk_upsert') {
    const dataToUpsert = (payload || []).filter(item => item.merchant_id);
    if (dataToUpsert.length === 0) {
        return res.status(400).json({ success: false, message: 'No valid records found. Ensure Merchant ID column is mapped.' });
    }

    try {
        // Process in chunks of 500 to avoid DB timeouts on large CSVs
        const CHUNK_SIZE = 500;
        let totalProcessed = 0;
        let errors = [];

        for (let i = 0; i < dataToUpsert.length; i += CHUNK_SIZE) {
            const chunk = dataToUpsert.slice(i, i + CHUNK_SIZE);
            const { error } = await supabase
                .from('merchants')
                .upsert(chunk, { onConflict: 'merchant_id', ignoreDuplicates: false });

            if (error) {
                errors.push(`Chunk ${Math.floor(i/CHUNK_SIZE) + 1}: ${error.message}`);
            } else {
                totalProcessed += chunk.length;
            }
        }

        if (errors.length > 0 && totalProcessed === 0) {
            return res.status(500).json({ success: false, message: errors[0] });
        }

        return res.status(200).json({ 
            success: true, 
            count: totalProcessed,
            errors: errors.length > 0 ? errors : undefined,
            message: errors.length > 0 
                ? `Processed ${totalProcessed} records with ${errors.length} chunk error(s).`
                : `Successfully synced ${totalProcessed} records.`
        });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
        // --- ACTION: getMerchantHistory in merchants.js ---
if (action === 'get_merchant_history') {
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
    try {
        // 1. Query the View
        let dataReq = supabase
            .from('merchant_portfolio_view')
            .select('*', { count: 'exact' });

        if (statusFilter) dataReq = dataReq.eq('account_status', statusFilter);

        // 2. Search Logic
       if (query && filterBy) {
    const colMap = {
        'dba_name': 'dba_name',
        'merchant_id': 'merchant_id',
        'agent_id': 'agent_id',
        // FIX: Point the search to the actual column name in the view
        'company_name': 'company_display_name', 
        'partner_name': 'partner_full_name'
    };
    const targetCol = colMap[filterBy] || filterBy;
    dataReq.ilike(targetCol, `%${query}%`);
}

        const { data, count, error: dataError } = await dataReq
            .range(page * limit, (page + 1) * limit - 1)
            .order('created_at', { ascending: false });

        if (dataError) throw dataError;

        // 3. Metrics
        let stats = { out_mtd: 0, out_30d: 0, out_90d: 0, out_abs_mtd: 0 };
        try {
            const { data: mathData, error: metricsError } = await supabase.rpc('get_merchant_metrics', { 
                p_status_filter: statusFilter || null, 
                p_query: query || null, 
                p_filter_by: filterBy === 'partner_name' ? 'partner_full_name' : (filterBy || null)
            });
            if (metricsError) console.error("Metrics error:", metricsError.message);
            if (mathData && mathData[0]) stats = mathData[0];
        } catch (e) { console.error("Metrics skipped:", e.message); }

        // Calculate portfolio share: filtered MTD / total portfolio MTD * 100
        const filteredMTD = parseFloat(stats.out_mtd) || 0;
        const totalMTD = parseFloat(stats.out_abs_mtd) || 0;
        const portfolioShare = totalMTD > 0 
            ? ((filteredMTD / totalMTD) * 100).toFixed(2)
            : "0.00";

        // 4. Format Data for Frontend
        const formattedData = (data || []).map(m => ({
            ...m,
            partner_name: m.partner_full_name || '---',
            company_name: m.company_display_name || '---', 
            is_prime49: m.is_prime49 || false
        }));

        return res.status(200).json({ 
            success: true, 
            data: formattedData,
            count: count || 0,
            metrics: { 
                totalMTD: filteredMTD,
                total30D: parseFloat(stats.out_30d) || 0,
                total90D: parseFloat(stats.out_90d) || 0,
                portfolioShare
            }
        });
    } catch (err) {
        console.error("Critical API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
     if (action === 'update') {
    // 1. Validate ID
    if (!id) return res.status(400).json({ success: false, message: "Missing Merchant UUID" });

    // 2. Perform the Update on the BASE TABLE
    const { data, error } = await supabase
        .from('merchants') // TARGET THE TABLE, NOT THE VIEW
        .update(payload) 
        .eq('id', id)
        .select(); // Select returns the updated row to verify it worked

    if (error) {
        console.error("Supabase Update Error:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }

    // 3. Log the change in merchant_notes for audit trail
    try {
        await supabase.from('merchant_notes').insert([{
            merchant_id: id,
            title: "System Update",
            body: `Manual profile update performed. Fields impacted: ${Object.keys(payload).join(', ')}`,
            created_by: user || 'Admin'
        }]);
    } catch (noteErr) {
        console.warn("Update succeeded, but audit note failed:", noteErr.message);
    }

    return res.status(200).json({ success: true, data });
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

    // 1. Fetch the notes simply (No JOINs to break the query)
    let q = supabase.from('merchant_notes').select('*').eq('merchant_id', merchant_uuid);
    if (type === 'manual') q = q.neq('title', 'System Update');
    else if (type === 'system') q = q.eq('title', 'System Update');
    
    const { data: notes, error: nErr } = await q.order('created_at', { ascending: false });
    if (nErr) throw nErr;

    // 2. Fetch all users to create a Name Map
    const { data: users } = await supabase.from('app_users').select('userid, first_name, last_name');
    const userMap = {};
    if (users) {
        users.forEach(u => {
            userMap[u.userid] = `${u.first_name} ${u.last_name || ''}`.trim();
        });
    }

    // 3. Map the names manually
    const formattedData = (notes || []).map(n => ({
        ...n,
        // If created_by matches a UUID in our map, use the name; otherwise, keep the original string
        display_name: userMap[n.created_by] || n.created_by || 'Unknown Staff'
    }));

    return res.status(200).json({ success: true, data: formattedData });
}
    if (action === 'add_note') {
    const { merchant_uuid, title, body, created_by } = req.body;
    // We save the UUID (pp_userid) directly into the created_by column
    const { error } = await supabase
        .from('merchant_notes')
        .insert([{ 
            merchant_id: merchant_uuid, 
            title: title, 
            body: body, 
            created_by: created_by // This is the UUID from localStorage
        }]);

    if (error) throw error;
    return res.status(200).json({ success: true });
}

        return res.status(400).json({ success: false, message: "Unknown action" });

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
} // End of handler function
