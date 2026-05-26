import { createClient } from '@supabase/supabase-js'
import { validateSession, sessionErrorResponse } from './_validate.js';
import { dispatchEvent } from './v1/_deliver.js';

// Increase body size limit to 50MB for large CSV bulk uploads
export const config = { api: { bodyParser: { sizeLimit: '50mb' } } };

/**
 * Compute a 0–100 merchant health score.
 * Components (when open ticket count is unavailable, scale 3 components to 100):
 *   - Volume trend (40 pts raw / 44.4 scaled)
 *   - Activity recency (30 pts raw / 33.3 scaled)
 *   - Account standing (20 pts raw / 22.2 scaled)
 *   - Support load (10 pts, only when open_ticket_count is present)
 */
function compute_health_score(merchant) {
    const hasTickets = typeof merchant.open_ticket_count === 'number';

    // 1. Volume trend (40 pts)
    const v30 = parseFloat(merchant.volume_30_day) || 0;
    const v90 = parseFloat(merchant.volume_90_day) || 0;
    const baseline = v90 / 3;
    let volumePts = 0;
    if (v30 > 0 && baseline > 0) {
        const ratio = v30 / baseline; // 1.0 = on pace
        if (ratio >= 1.0) volumePts = 40;
        else if (ratio >= 0.70) volumePts = 30; // 15–30% below → ratio 0.70–0.85
        else if (ratio >= 0.50) volumePts = 20; // 30–50% below → ratio 0.50–0.70
        else if (ratio >= 0.25) volumePts = 10; // 50–75% below → ratio 0.25–0.50
        else volumePts = 0;                     // >75% below
    }
    // If v30 > 0 but no 90d baseline treat as meeting baseline
    if (v30 > 0 && baseline === 0) volumePts = 40;

    // 2. Activity recency (30 pts)
    let recencyPts = 0;
    if (merchant.last_batch_date) {
        const daysSince = Math.floor((Date.now() - new Date(merchant.last_batch_date).getTime()) / 86400000);
        if (daysSince <= 7) recencyPts = 30;
        else if (daysSince <= 14) recencyPts = 20;
        else if (daysSince <= 30) recencyPts = 10;
        else recencyPts = 0;
    }

    // 3. Account standing (20 pts)
    let standingPts = 0;
    const status = (merchant.account_status || '').trim();
    if (status === 'Approved') standingPts = 20;
    else if (status === 'Pending') standingPts = 10;

    // 4. Support load (10 pts) — only when available
    let supportPts = 0;
    if (hasTickets) {
        const t = merchant.open_ticket_count;
        if (t === 0) supportPts = 10;
        else if (t === 1) supportPts = 6;
        else if (t === 2) supportPts = 3;
        else supportPts = 0;
    }

    let score;
    if (hasTickets) {
        score = volumePts + recencyPts + standingPts + supportPts;
    } else {
        // Scale 90-pt max to 100
        score = Math.round((volumePts + recencyPts + standingPts) * (100 / 90));
    }

    score = Math.min(100, Math.max(0, score));

    let label;
    if (score >= 80) label = 'Healthy';
    else if (score >= 60) label = 'Good';
    else if (score >= 40) label = 'Fair';
    else if (score >= 20) label = 'At Risk';
    else label = 'Critical';

    return { score, label };
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20, user } = req.body;
    
    try 
    
    
    {

        if (action === 'check_mids') {
    const { mids } = req.body;
    if (!mids || mids.length === 0) {
        return res.status(200).json({ success: true, existingMids: [] });
    }

    // Chunk MID lookup to avoid Supabase URL length limits
    const CHUNK_SIZE = 500;
    let existingMids = [];

    for (let i = 0; i < mids.length; i += CHUNK_SIZE) {
        const chunk = mids.slice(i, i + CHUNK_SIZE);
        const { data, error } = await supabase
            .from('merchants')
            .select('merchant_id')
            .in('merchant_id', chunk);

        if (error) throw error;
        if (data) existingMids = existingMids.concat(data.map(m => String(m.merchant_id)));
    }

    return res.status(200).json({ success: true, existingMids });
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
        return res.status(400).json({ success: false, message: error.message });
    }

    // In-app notification for the assignee
    if (assigned_to && assigned_to !== validCreator) {
        try {
            const { data: creatorUser } = await supabase
                .from('app_users').select('first_name, last_name').eq('userid', validCreator).maybeSingle();
            const fromName = creatorUser ? `${creatorUser.first_name} ${creatorUser.last_name || ''}`.trim() : 'Someone';
            const { data: merchantRow } = await supabase
                .from('merchants').select('dba_name').eq('id', merchant_uuid).maybeSingle();
            const dbaName = merchantRow?.dba_name || 'a merchant';
            await supabase.from('user_notifications').insert([{
                user_id: assigned_to,
                type: 'task',
                title: `${fromName} assigned you a task`,
                body: title || '',
                merchant_id: merchant_uuid,
                merchant_name: dbaName,
                task_id: data?.[0]?.id || null,
                from_name: fromName
            }]);
        } catch (e) {
            console.error('[Task Notify Error]', e.message);
        }
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
        const CHUNK_SIZE = 500;
        let totalProcessed = 0;
        let errors = [];

        // ── STEP 1: AUTO-CREATE MISSING AGENT IDENTIFIERS ──────────────────
        // Collect all unique agent_ids from the CSV
        const csvAgentIds = [...new Set(
            dataToUpsert
                .map(r => r.agent_id)
                .filter(id => id && String(id).trim() !== '')
                .map(id => String(id).trim())
        )];

        if (csvAgentIds.length > 0) {
            // Find which ones already exist in agent_identifiers
            const existingIds = new Set();
            for (let i = 0; i < csvAgentIds.length; i += CHUNK_SIZE) {
                const chunk = csvAgentIds.slice(i, i + CHUNK_SIZE);
                const { data: existing } = await supabase
                    .from('agent_identifiers')
                    .select('id_string')
                    .in('id_string', chunk);
                if (existing) existing.forEach(r => existingIds.add(r.id_string));
            }

            // Find the missing ones
            const missingAgentIds = csvAgentIds.filter(id => !existingIds.has(id));

            if (missingAgentIds.length > 0) {
                // For each missing agent_id, create a placeholder agent + identifier
                // We group by agent_name if available in the CSV, otherwise use the ID as name
                const agentNameMap = {};
                dataToUpsert.forEach(r => {
                    if (r.agent_id && r.agent_name) {
                        agentNameMap[String(r.agent_id).trim()] = r.agent_name;
                    }
                });

                for (const agentId of missingAgentIds) {
                    // 1. Create the agent record
                    const agentName = agentNameMap[agentId] || `Agent ${agentId}`;
                    const { data: newAgent, error: agentError } = await supabase
                        .from('agents')
                        .insert({ agent_name: agentName, is_active: true })
                        .select('id')
                        .single();

                    if (agentError) {
                        console.error(`Failed to create agent ${agentId}:`, agentError.message);
                        continue;
                    }

                    // 2. Create the agent_identifier linking the string ID to the agent
                    const { error: identError } = await supabase
                        .from('agent_identifiers')
                        .insert({
                            agent_id: newAgent.id,
                            id_string: agentId,
                            status: 'Active'
                        });

                    if (identError) {
                        console.error(`Failed to create identifier for agent ${agentId}:`, identError.message);
                    }
                }
            }
        }

        // ── STEP 2: UPSERT MERCHANTS IN CHUNKS ─────────────────────────────
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

        try {
            await supabase.from('activity_logs').insert({
                email: session?.email || session?.userid || 'unknown',
                action: `Bulk Upload Merchants — ${totalProcessed} records synced`,
                status: errors.length > 0 ? 'partial' : 'success',
                category: 'merchants',
                target_type: 'merchant',
                severity: 'info',
                new_value: {
                    count: totalProcessed,
                    records: dataToUpsert.map(r => ({
                        merchant_id:   r.merchant_id,
                        dba_name:      r.dba_name      || null,
                        status:        r.status        || null,
                        agent_id:      r.agent_id      || null,
                        partner_name:  r.partner_name  || null,
                        state:         r.state         || null,
                        city:          r.city          || null,
                    })),
                    errors: errors.length > 0 ? errors : undefined
                }
            });
        } catch (logErr) {
            console.warn('Activity log failed:', logErr.message);
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
if (action === 'get_full_merchant') {
    const { merchant_uuid } = req.body;
    if (!merchant_uuid) return res.status(400).json({ success: false, message: 'merchant_uuid required' });
    const { data, error } = await supabase
        .from('merchants')
        .select('*')
        .eq('id', merchant_uuid)
        .single();
    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, data });
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

if (action === 'get_merchant_equipment') {
    const { merchant_uuid } = req.body;

    // Currently assigned equipment — no FK join, just base fields
    const { data: current, error: e1 } = await supabase
        .from('equipments')
        .select('id, serial_number, terminal_type, status, received_date')
        .eq('merchant_id', merchant_uuid)
        .order('serial_number');
    if (e1) throw e1;

    // Find active deployment display IDs for these units
    const equipIds = (current || []).map(e => e.id);
    const equipToDepId = {};
    if (equipIds.length > 0) {
        // Single-unit deployments
        const { data: singleDeps } = await supabase
            .from('deployments')
            .select('deployment_id, equipment_id')
            .in('equipment_id', equipIds)
            .neq('status', 'Closed');
        (singleDeps || []).forEach(d => { equipToDepId[d.equipment_id] = d.deployment_id; });

        // Bulk deployments via deployment_items
        const { data: bulkItems } = await supabase
            .from('deployment_items')
            .select('equipment_id, dep:deployment_id(deployment_id, status)')
            .in('equipment_id', equipIds);
        (bulkItems || []).forEach(item => {
            if (item.dep?.status !== 'Closed' && !equipToDepId[item.equipment_id]) {
                equipToDepId[item.equipment_id] = item.dep?.deployment_id;
            }
        });
    }

    const currentWithDep = (current || []).map(e => ({
        ...e,
        deployment_display_id: equipToDepId[e.id] || null
    }));

    // Closed deployments for this merchant (past equipment)
    const { data: closedDeps, error: e2 } = await supabase
        .from('deployments')
        .select(`
            id, deployment_id, is_bulk, equipment_id,
            equipments:equipment_id(serial_number, terminal_type),
            deployment_items(equipment_id, equip:equipment_id(serial_number, terminal_type)),
            returns(return_id)
        `)
        .eq('merchant_id', merchant_uuid)
        .eq('status', 'Closed')
        .order('created_at', { ascending: false });
    if (e2) throw e2;

    // Exclude equipment that is currently deployed to this merchant
    const currentEquipIds = new Set(equipIds);

    const past = [];
    for (const dep of (closedDeps || [])) {
        const returnDisplayId = dep.returns?.[0]?.return_id || null;
        if (dep.is_bulk) {
            for (const item of (dep.deployment_items || [])) {
                if (currentEquipIds.has(item.equipment_id)) continue;
                past.push({
                    serial_number: item.equip?.serial_number || 'N/A',
                    terminal_type: item.equip?.terminal_type || 'N/A',
                    deployment_display_id: dep.deployment_id,
                    return_display_id: returnDisplayId
                });
            }
        } else if (dep.equipment_id) {
            if (currentEquipIds.has(dep.equipment_id)) continue;
            past.push({
                serial_number: dep.equipments?.serial_number || 'N/A',
                terminal_type: dep.equipments?.terminal_type || 'N/A',
                deployment_display_id: dep.deployment_id,
                return_display_id: returnDisplayId
            });
        }
    }

    return res.status(200).json({ success: true, current: currentWithDep, past });
}
        // --- ACTION: ADD ATTACHMENT RECORD ---
        if (action === 'add_attachment') {
            const { merchant_id, file_name, file_path, file_type, file_size, uploaded_by } = req.body;

            const { data, error } = await supabase
                .from('merchant_attachments')
                .insert([{ merchant_id, file_name, file_path, file_type, file_size, uploaded_by }]);

            if (error) throw error;
            supabase.from('activity_logs').insert({
                email: session?.email || uploaded_by || 'Staff', action: `File uploaded: ${file_name}`,
                status: 'success', category: 'merchants', target_id: merchant_id, target_type: 'merchant', severity: 'info',
                new_value: { file_name, file_type, file_size }
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true });
        }

        if (action === 'update_note') {
            const { note_id, title, body } = req.body;
            const { data: oldNote } = await supabase.from('merchant_notes').select('title, body, merchant_id').eq('id', note_id).single();
            const { error } = await supabase
                .from('merchant_notes')
                .update({ title, body, updated_at: new Date().toISOString() })
                .eq('id', note_id);

            if (error) throw error;
            supabase.from('activity_logs').insert({
                email: session?.email || 'Staff', action: `Merchant note updated`,
                status: 'success', category: 'merchants', target_id: oldNote?.merchant_id || note_id, target_type: 'merchant', severity: 'info',
                old_value: { title: oldNote?.title, body: oldNote?.body?.slice(0, 500) },
                new_value: { title, body: body?.slice(0, 500) }
            }).then(() => {}).catch(() => {});
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

if (action === 'get_stats_for_filter') {
    try {
        const { data, error } = await supabase.rpc('get_portfolio_health_summary');
        if (error) throw error;
        const summary = typeof data === 'string' ? JSON.parse(data) : data;
        return res.status(200).json({
            success: true,
            health: summary.health,
            top10:  summary.top10 || [],
            total:  summary.total
        });
    } catch (err) {
        console.error("get_stats_for_filter error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
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
        'company_name': 'company_display_name',
        'partner_name': 'partner_full_name'
    };
    if (!colMap[filterBy]) {
        return res.status(400).json({ success: false, message: `Invalid filter field: ${filterBy}` });
    }
    const targetCol = colMap[filterBy];
    dataReq = dataReq.ilike(targetCol, `%${query}%`);
}

        const VALID_SORT = ['dba_name', 'volume_30_day', 'volume_mtd', 'account_status', 'enrollment_date'];
        const sortField = VALID_SORT.includes(req.body.sort_by) ? req.body.sort_by : 'created_at';
        const sortAsc = req.body.sort_dir === 'asc';

        const { data, count, error: dataError } = await dataReq
            .range(page * limit, (page + 1) * limit - 1)
            .order(sortField, { ascending: sortAsc, nullsFirst: false });

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
        const formattedData = (data || []).map(m => {
            const { score, label } = compute_health_score(m);
            return {
                ...m,
                partner_name: m.partner_full_name || '---',
                company_name: m.company_display_name || '---',
                is_prime49: m.is_prime49 || false,
                health_score: score,
                health_label: label
            };
        });

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

    // Fetch current status if account_status is being changed
    let oldStatus = null;
    if (payload.account_status !== undefined) {
        const { data: cur } = await supabase.from('merchants')
            .select('account_status, dba_name, merchant_id, agent_id')
            .eq('id', id).single();
        oldStatus = cur;
    }

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

    // 4. Fire merchant.status_changed webhook event if status changed
    if (oldStatus && payload.account_status && payload.account_status !== oldStatus.account_status) {
        try {
            const { data: identifier } = await supabase
                .from('agent_identifiers')
                .select('agents!agent_identifiers_agent_id_fkey(parent_agent_id)')
                .eq('id_string', oldStatus.agent_id)
                .single();
            const personId = identifier?.agents?.parent_agent_id;
            if (personId) {
                dispatchEvent(personId, 'merchant.status_changed', {
                    merchant_id: oldStatus.merchant_id,
                    dba_name: oldStatus.dba_name,
                    old_status: oldStatus.account_status,
                    new_status: payload.account_status,
                    changed_by: user || 'Admin'
                }).catch(() => {});
            }
        } catch (e) { /* non-fatal */ }
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
    const { merchant_uuid, title, body, created_by, mentions } = req.body;
    const { data: noteRow, error } = await supabase
        .from('merchant_notes')
        .insert([{ merchant_id: merchant_uuid, title, body, created_by }])
        .select('id')
        .single();

    if (error) throw error;

    // Always fetch actor + merchant for rich logging and notifications
    const [{ data: actorRow }, { data: merchantRow }] = await Promise.all([
        supabase.from('app_users').select('email, first_name, last_name').eq('userid', session?.userid || created_by).maybeSingle(),
        supabase.from('merchants').select('dba_name, merchant_id').eq('id', merchant_uuid).maybeSingle()
    ]);
    const actorEmail = actorRow?.email || created_by || 'Staff';
    const actorName  = actorRow ? `${actorRow.first_name || ''} ${actorRow.last_name || ''}`.trim() || actorRow.email : 'Staff';
    const dbaName    = merchantRow?.dba_name || 'Unknown Merchant';
    const mid        = merchantRow?.merchant_id || '';

    let mentionedUsers = [];
    if (mentions?.length) {
        const { data: mu } = await supabase.from('app_users').select('userid, first_name, last_name, email').in('userid', mentions);
        mentionedUsers = mu || [];
    }
    const taggedNames = mentionedUsers.map(u => `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email).filter(Boolean);

    supabase.from('activity_logs').insert({
        email: actorEmail,
        action: `Note added on ${dbaName}${mid ? ` [${mid}]` : ''}: "${title || 'Untitled'}"`,
        status: 'success', category: 'merchants', target_id: merchant_uuid, target_type: 'merchant', severity: 'info',
        new_value: {
            merchant: dbaName,
            merchant_id: mid || undefined,
            note_id: noteRow?.id,
            title: title || 'Untitled',
            body: body?.slice(0, 500),
            ...(taggedNames.length ? { tagged: taggedNames } : {})
        }
    }).then(() => {}).catch(() => {});

    // Send @mention email notifications + in-app notifications
    if (mentionedUsers.length) {
        try {
            const taggerName = actorName;
            // In-app notifications
            {
                await supabase.from('user_notifications').insert(
                    mentionedUsers.map(u => ({
                        user_id: u.userid,
                        type: 'mention',
                        title: `${taggerName} mentioned you`,
                        body: (body || '').slice(0, 200),
                        merchant_id: merchant_uuid,
                        merchant_name: dbaName,
                        note_id: noteRow?.id || null,
                        from_name: taggerName
                    }))
                );

                // Email notifications
                if (process.env.POSTMARK_SERVER_TOKEN) {
                    const { ServerClient } = await import('postmark');
                    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                    await Promise.all(mentionedUsers.map(u => {
                        if (!u.email) return;
                        const firstName = u.first_name || 'there';
                        return client.sendEmail({
                            From: process.env.EMAIL_FROM,
                            To: u.email,
                            Subject: `${taggerName} mentioned you in a note`,
                            HtmlBody: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
<p style="margin:0 0 8px;">Hi ${firstName},</p>
<p style="margin:0 0 16px;"><strong>${taggerName}</strong> mentioned you in a note for <strong>${dbaName}</strong>:</p>
<blockquote style="margin:0 0 20px;padding:12px 16px;background:#f8fafc;border-left:4px solid #004990;border-radius:4px;font-size:14px;color:#334155;">${(body || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')}</blockquote>
<p style="margin:0;font-size:12px;color:#94a3b8;">You received this because you were @mentioned in the merchant management console.</p>
</div>`,
                            TextBody: `Hi ${firstName},\n\n${taggerName} mentioned you in a note for ${dbaName}:\n\n"${body}"\n\nYou received this because you were @mentioned in the merchant management console.`,
                            MessageStream: 'outbound'
                        });
                    }));
                }
            }
        } catch (e) {
            console.error('[Mention Error]', e.message);
        }
    }

    return res.status(200).json({ success: true });
}

        // --- ACTION: lookup_agent ---
        if (action === 'lookup_agent') {
            const { agent_id: agentIdStr } = req.body;
            if (!agentIdStr) return res.status(200).json({ found: false });

            const { data: identifier } = await supabase
                .from('agent_identifiers')
                .select('id_string, agents!agent_identifiers_agent_id_fkey(agent_name)')
                .eq('id_string', String(agentIdStr).trim())
                .maybeSingle();

            if (identifier) {
                return res.status(200).json({
                    found: true,
                    agent_name: identifier.agents?.agent_name || agentIdStr
                });
            }
            return res.status(200).json({ found: false });
        }

        // --- ACTION: create ---
        if (action === 'create') {
            const {
                merchant_id, dba_name, agent_id, agent_name, account_status, email,
                merchant_phone, merchant_primary_contact, merchant_address, merchant_city,
                merchant_state, merchant_zip, merchant_country, merchant_websites,
                status_id, account_code, major_merchant, ach_properties, processor,
                processor_platform, gateway_account_id, is_edge_enabled, is_pci_compliant,
                is_mobile, source, is_activated, is_device_hub_link_enabled,
                volume_mtd, volume_30_day, volume_90_day, volume,
                fresno_buy_rate_tier, isv_commission_code, enrollment_date, approved_date,
                last_batch_date, account_status_change_date, shipping_status, irs_tin_status, ndf
            } = req.body;

            // Validate required fields
            if (!merchant_id || !dba_name) {
                return res.status(400).json({ success: false, message: 'Merchant ID and DBA Name are required.' });
            }

            // Check for duplicate merchant_id
            const { data: existing } = await supabase
                .from('merchants')
                .select('merchant_id')
                .eq('merchant_id', String(merchant_id).trim())
                .maybeSingle();

            if (existing) {
                return res.status(400).json({ success: false, message: 'Merchant ID already exists.' });
            }

            // Partner ID lookup/create — same pattern as bulk_upsert
            if (agent_id && String(agent_id).trim()) {
                const agentIdStr = String(agent_id).trim();

                const { data: existingIdent } = await supabase
                    .from('agent_identifiers')
                    .select('id_string')
                    .eq('id_string', agentIdStr)
                    .maybeSingle();

                if (!existingIdent) {
                    // Create a new agent record
                    const agentDisplayName = (agent_name && String(agent_name).trim())
                        ? String(agent_name).trim()
                        : `Agent ${agentIdStr}`;

                    const { data: newAgent, error: agentError } = await supabase
                        .from('agents')
                        .insert({ agent_name: agentDisplayName, is_active: true })
                        .select('id')
                        .single();

                    if (!agentError && newAgent) {
                        await supabase
                            .from('agent_identifiers')
                            .insert({ agent_id: newAgent.id, id_string: agentIdStr, status: 'Active' });
                    }
                }
            }

            // Build merchant record — omit null/empty optional fields
            const merchantRecord = { merchant_id: String(merchant_id).trim(), dba_name };
            const optionalFields = {
                agent_id: agent_id || null,
                account_status: account_status || null,
                email: email || null,
                merchant_phone: merchant_phone || null,
                merchant_primary_contact: merchant_primary_contact || null,
                merchant_address: merchant_address || null,
                merchant_city: merchant_city || null,
                merchant_state: merchant_state || null,
                merchant_zip: merchant_zip || null,
                merchant_country: merchant_country || null,
                merchant_websites: merchant_websites || null,
                status_id: status_id || null,
                account_code: account_code || null,
                major_merchant: major_merchant || null,
                ach_properties: ach_properties || null,
                processor: processor || null,
                processor_platform: processor_platform || null,
                gateway_account_id: gateway_account_id || null,
                is_edge_enabled: is_edge_enabled != null ? is_edge_enabled : null,
                is_pci_compliant: is_pci_compliant != null ? is_pci_compliant : null,
                is_mobile: is_mobile != null ? is_mobile : null,
                source: source || 'manual',
                is_activated: is_activated != null ? is_activated : null,
                is_device_hub_link_enabled: is_device_hub_link_enabled != null ? is_device_hub_link_enabled : null,
                volume_mtd: volume_mtd || null,
                volume_30_day: volume_30_day || null,
                volume_90_day: volume_90_day || null,
                volume: volume || null,
                fresno_buy_rate_tier: fresno_buy_rate_tier || null,
                isv_commission_code: isv_commission_code || null,
                enrollment_date: enrollment_date || null,
                approved_date: approved_date || null,
                last_batch_date: last_batch_date || null,
                account_status_change_date: account_status_change_date || null,
                shipping_status: shipping_status || null,
                irs_tin_status: irs_tin_status || null,
                ndf: ndf || null
            };

            // Only include non-null values
            for (const [k, v] of Object.entries(optionalFields)) {
                if (v !== null && v !== undefined && v !== '') merchantRecord[k] = v;
            }
            // Always set source
            merchantRecord.source = source || 'manual';

            const { error: insertError } = await supabase
                .from('merchants')
                .insert(merchantRecord);

            if (insertError) {
                return res.status(500).json({ success: false, message: insertError.message });
            }

            // Write activity_log entry
            try {
                const actingUser = session?.userid || session?.email || 'Admin';
                await supabase.from('activity_logs').insert({
                    email: actingUser,
                    action: 'Create Merchant',
                    status: 'success',
                    category: 'merchants',
                    target_id: String(merchant_id).trim(),
                    target_type: 'merchant',
                    severity: 'info'
                });
            } catch (logErr) {
                console.warn('Activity log failed:', logErr.message);
            }

            return res.status(200).json({ success: true, merchant_id: String(merchant_id).trim() });
        }

        // --- ACTION: get_my_notifications ---
        if (action === 'get_my_notifications') {
            const { user_id } = req.body;
            if (!user_id) return res.status(400).json({ success: false, message: 'user_id required' });
            const { data: notifs, error: nErr } = await supabase
                .from('user_notifications')
                .select('*')
                .eq('user_id', user_id)
                .order('created_at', { ascending: false })
                .limit(50);
            if (nErr) throw nErr;
            return res.status(200).json({ success: true, data: notifs || [] });
        }

        // --- ACTION: mark_notification_read ---
        if (action === 'mark_notification_read') {
            const { notification_id, user_id, mark_all } = req.body;
            if (mark_all && user_id) {
                await supabase.from('user_notifications').update({ is_read: true }).eq('user_id', user_id).eq('is_read', false);
            } else if (notification_id) {
                await supabase.from('user_notifications').update({ is_read: true }).eq('id', notification_id);
            }
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: "Unknown action" });

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
} // End of handler function
