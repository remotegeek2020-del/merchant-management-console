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

    if (error) {
        console.error('[API Error]', error.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
    }

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

    // Fetch task details before deletion for the audit log
    const { data: taskToDelete } = await supabase
        .from('merchant_tasks')
        .select('title, status, due_date, assigned_to, merchant_id, merchants:merchant_id(dba_name)')
        .eq('id', task_id).maybeSingle();

    const { error } = await supabase
        .from('merchant_tasks')
        .delete()
        .eq('id', task_id);

    if (error) throw error;

    const { data: dtActorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const dtActorEmail = dtActorRow?.email || session.userid;
    const dtActorName  = dtActorRow ? `${dtActorRow.first_name || ''} ${dtActorRow.last_name || ''}`.trim() || dtActorRow.email : 'Staff';
    supabase.from('activity_logs').insert({
        email: dtActorEmail,
        action: `Task Deleted by ${dtActorName} — "${taskToDelete?.title || task_id}"`,
        status: 'success', category: 'merchants',
        target_id: task_id, target_type: 'task',
        severity: 'warning',
        old_value: {
            title: taskToDelete?.title,
            status: taskToDelete?.status,
            due_date: taskToDelete?.due_date,
            merchant: taskToDelete?.merchants?.dba_name || taskToDelete?.merchant_id
        },
        new_value: { deleted: true }
    }).then(() => {}).catch(() => {});

    return res.status(200).json({ success: true });
}
        // --- ACTION: add_task (api/merchants.js) ---
if (action === 'add_task') {
    const { merchant_uuid, title, body, due_date, assigned_to } = req.body;

    const { data, error } = await supabase
        .from('merchant_tasks')
        .insert([{
            merchant_id: merchant_uuid,
            title: title,
            body: body,
            due_date: due_date || null,
            assigned_to: assigned_to || null,
            created_by: session.userid,
            status: 'Pending'
        }])
        .select();

    if (error) {
        console.error("DB Error:", error.message);
        return res.status(400).json({ success: false, message: error.message });
    }

    // In-app notification for the assignee
    if (assigned_to && assigned_to !== session.userid) {
        try {
            const { data: creatorUser } = await supabase
                .from('app_users').select('first_name, last_name').eq('userid', session.userid).maybeSingle();
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

    const { data: actorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const actorLabel = actorRow ? `${actorRow.first_name || ''} ${actorRow.last_name || ''}`.trim() || actorRow.email : session.userid;
    supabase.from('activity_logs').insert({
        email: actorRow?.email || session.userid,
        action: `Task Created by ${actorLabel} — ${title}`,
        status: 'success', category: 'tasks', target_id: data?.[0]?.id || null, target_type: 'task', severity: 'info',
        old_value: null,
        new_value: { title, body: body || null, due_date: due_date || null, assigned_to: assigned_to || null, merchant_id: merchant_uuid, status: 'Pending' }
    }).then(() => {}).catch(() => {});

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

    const { data: utsActorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const utsActorEmail = utsActorRow?.email || session.userid;
    const utsActorName  = utsActorRow ? `${utsActorRow.first_name || ''} ${utsActorRow.last_name || ''}`.trim() || utsActorRow.email : 'Staff';
    supabase.from('activity_logs').insert({
        email: utsActorEmail,
        action: `Task Status Updated by ${utsActorName} — ${task?.status || '?'} → ${newStatus}`,
        status: 'success', category: 'merchants',
        target_id: task_id, target_type: 'task',
        severity: 'info',
        old_value: { status: task?.status },
        new_value: { status: newStatus }
    }).then(() => {}).catch(() => {});

    return res.status(200).json({ success: true, status: newStatus });
}

        // --- ACTION: update_task (api/merchants.js) ---
if (action === 'update_task') {
    const { task_id, payload } = req.body;

    // Fetch current state before update for audit log
    const { data: oldTask } = await supabase
        .from('merchant_tasks')
        .select('title, status, due_date, assigned_to, merchant_id, merchants:merchant_id(dba_name)')
        .eq('id', task_id).maybeSingle();

    const { error } = await supabase
        .from('merchant_tasks')
        .update({
            title: payload.title,
            body: payload.body,
            due_date: payload.due_date,
            assigned_to: payload.assigned_to,
            status: payload.status
        })
        .eq('id', task_id);

    if (error) throw error;

    const { data: utActorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const utActorEmail = utActorRow?.email || session.userid;
    const utActorName  = utActorRow ? `${utActorRow.first_name || ''} ${utActorRow.last_name || ''}`.trim() || utActorRow.email : 'Staff';
    supabase.from('activity_logs').insert({
        email: utActorEmail,
        action: `Task Updated by ${utActorName} — "${payload.title || oldTask?.title || task_id}"`,
        status: 'success', category: 'merchants',
        target_id: task_id, target_type: 'task',
        severity: 'info',
        old_value: { title: oldTask?.title, status: oldTask?.status, due_date: oldTask?.due_date, merchant: oldTask?.merchants?.dba_name },
        new_value: { title: payload.title, status: payload.status, due_date: payload.due_date }
    }).then(() => {}).catch(() => {});

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

        // ── PRE-STEP 2: Snapshot existing merchant_ids for new-merchant detection
        const allUploadedMids = dataToUpsert.map(r => r.merchant_id).filter(Boolean);
        const priorExistingMids = new Set();
        for (let i = 0; i < allUploadedMids.length; i += CHUNK_SIZE) {
            const chunk = allUploadedMids.slice(i, i + CHUNK_SIZE);
            const { data: existingRows } = await supabase
                .from('merchants').select('merchant_id').in('merchant_id', chunk);
            (existingRows || []).forEach(r => priorExistingMids.add(r.merchant_id));
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

        const { data: bulkActorRow } = await supabase.from('app_users').select('email').eq('userid', session.userid).maybeSingle();
        const bulkActorEmail = bulkActorRow?.email || session.userid;

        try {
            await supabase.from('activity_logs').insert({
                email: bulkActorEmail,
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

        // ── STEP 3: PRIME49 TASK AUTOMATION (fire-and-forget, never blocks) ──
        const _autoSession = session;
        const _newMerchants = dataToUpsert.filter(r => r.merchant_id && !priorExistingMids.has(r.merchant_id));
        if (_newMerchants.length > 0) {
            (async () => {
                try {
                    const { data: cfg } = await supabase
                        .from('prime49_task_automation_config')
                        .select('*').eq('id', 1).maybeSingle();
                    if (!cfg || !cfg.enabled) return;

                    // Which new merchants have a prime49 agent_id?
                    const newAgentIds = [...new Set(_newMerchants.map(r => r.agent_id).filter(Boolean))];
                    if (!newAgentIds.length) return;

                    const { data: p49Ids } = await supabase
                        .from('agent_identifiers')
                        .select('id_string')
                        .in('id_string', newAgentIds)
                        .eq('prime49', true);
                    if (!p49Ids || !p49Ids.length) return;

                    const p49Set = new Set(p49Ids.map(r => r.id_string));
                    const p49New = _newMerchants.filter(r => p49Set.has(r.agent_id));
                    if (!p49New.length) return;

                    // Fetch merchant UUIDs (merchant_tasks.merchant_id is FK to merchants.id)
                    const { data: mRows } = await supabase
                        .from('merchants')
                        .select('id, merchant_id, dba_name, agent_id, enrollment_date, account_status')
                        .in('merchant_id', p49New.map(r => r.merchant_id));
                    if (!mRows || !mRows.length) return;

                    const resolveTpl = (tpl, csv, m) => (tpl || '')
                        .replace(/\{\{dba_name\}\}/gi,        m.dba_name       || csv.dba_name       || '—')
                        .replace(/\{\{mid\}\}/gi,             m.merchant_id    || '—')
                        .replace(/\{\{agent_id\}\}/gi,        m.agent_id       || csv.agent_id       || '—')
                        .replace(/\{\{partner_name\}\}/gi,    csv.partner_name || csv.agent_name     || '—')
                        .replace(/\{\{enrollment_date\}\}/gi, m.enrollment_date || csv.enrollment_date || '—')
                        .replace(/\{\{account_status\}\}/gi,  m.account_status || csv.status         || '—');

                    const tasks = mRows.map(m => {
                        const csv = p49New.find(r => r.merchant_id === m.merchant_id) || {};
                        return {
                            title:       resolveTpl(cfg.task_title_template, csv, m),
                            body:        resolveTpl(cfg.task_description_template, csv, m),
                            priority:    cfg.priority || 'Normal',
                            status:      'Pending',
                            merchant_id: m.id,
                            assigned_to: cfg.assignee_id || null,
                            created_by:  _autoSession.userid,
                            source:      'prime49_auto'
                        };
                    });

                    const { error: taskErr } = await supabase.from('merchant_tasks').insert(tasks);
                    if (taskErr) console.warn('[prime49-auto] Task insert failed:', taskErr.message);
                    else console.log(`[prime49-auto] Created ${tasks.length} task(s) for new Prime49 merchants`);
                } catch (autoErr) {
                    console.warn('[prime49-auto] Error:', autoErr.message);
                }
            })();
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
        console.error('[API Error]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
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

    // Single SQL function handles single + bulk deployment date joins
    const { data: current, error: e1 } = await supabase
        .rpc('get_merchant_equipment_with_deployment', { p_merchant_uuid: merchant_uuid });
    if (e1) throw e1;

    const currentEquipIds = new Set((current || []).map(e => e.id));

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

    return res.status(200).json({ success: true, current: current || [], past });
}

// ── UPGRADE ELIGIBLE ─────────────────────────────────────────────────────────
if (action === 'get_upgrade_eligible') {
    const CHUNK = 400;

    // 1. All prime49 agent IDs (already enrolled — exclude these)
    const { data: p49Rows } = await supabase
        .from('agent_identifiers').select('id_string').eq('prime49', true);
    const prime49Set = new Set((p49Rows || []).map(r => r.id_string).filter(Boolean));

    // 2. All merchants with volume > 0, ordered by volume desc
    const { data: merchants, error: mErr } = await supabase
        .from('merchants')
        .select('id, dba_name, merchant_id, agent_id, account_status, volume, volume_30_day, volume_mtd')
        .gt('volume', 0)
        .order('volume', { ascending: false })
        .limit(5000);
    if (mErr) return res.json({ success: false, message: mErr.message });

    // 3. Exclude already-prime49 merchants
    const candidates = (merchants || []).filter(m => !prime49Set.has(m.agent_id));
    if (!candidates.length) return res.json({ success: true, data: [] });

    const candidateIds = candidates.map(m => m.id);

    // 4. Find which have equipment
    const depMids = new Set();
    const legMids = new Set();
    for (let i = 0; i < candidateIds.length; i += CHUNK) {
        const chunk = candidateIds.slice(i, i + CHUNK);
        const { data: deps } = await supabase.from('deployments').select('merchant_id').in('merchant_id', chunk).eq('status', 'Open');
        (deps || []).forEach(d => depMids.add(d.merchant_id));
        const { data: legs } = await supabase.from('legacy_deployments').select('merchant_id').in('merchant_id', chunk);
        (legs || []).forEach(l => legMids.add(l.merchant_id));
    }

    const eligible = candidates.filter(m => depMids.has(m.id) || legMids.has(m.id));
    if (!eligible.length) return res.json({ success: true, data: [] });

    const eligibleIds = eligible.map(m => m.id);

    // 5. Gather equipment for eligible merchants
    const currentByMerchant = {};
    const legacyByMerchant  = {};

    for (let i = 0; i < eligibleIds.length; i += CHUNK) {
        const chunk = eligibleIds.slice(i, i + CHUNK);

        // Single-unit open deployments
        const { data: singles } = await supabase
            .from('deployments')
            .select('merchant_id, equipments:equipment_id(serial_number, terminal_type)')
            .in('merchant_id', chunk).eq('status', 'Open').eq('is_bulk', false);
        (singles || []).forEach(d => {
            if (!d.equipments) return;
            (currentByMerchant[d.merchant_id] = currentByMerchant[d.merchant_id] || [])
                .push({ serial_number: d.equipments.serial_number, terminal_type: d.equipments.terminal_type });
        });

        // Bulk open deployments
        const { data: bulks } = await supabase
            .from('deployments')
            .select('merchant_id, deployment_items(equip:equipment_id(serial_number, terminal_type))')
            .in('merchant_id', chunk).eq('status', 'Open').eq('is_bulk', true);
        (bulks || []).forEach(d => {
            (d.deployment_items || []).forEach(item => {
                if (!item.equip) return;
                (currentByMerchant[d.merchant_id] = currentByMerchant[d.merchant_id] || [])
                    .push({ serial_number: item.equip.serial_number, terminal_type: item.equip.terminal_type });
            });
        });

        // Legacy deployments
        const { data: legs } = await supabase
            .from('legacy_deployments')
            .select('merchant_id, serial_number, terminal_type, status')
            .in('merchant_id', chunk).neq('status', 'converted');
        (legs || []).forEach(l => {
            (legacyByMerchant[l.merchant_id] = legacyByMerchant[l.merchant_id] || [])
                .push({ serial_number: l.serial_number, terminal_type: l.terminal_type, status: l.status });
        });
    }

    // 6. Partner info
    const agentIds = [...new Set(eligible.map(m => m.agent_id).filter(Boolean))];
    const partnerMap = {};
    for (let i = 0; i < agentIds.length; i += CHUNK) {
        const chunk = agentIds.slice(i, i + CHUNK);
        const { data: idents } = await supabase
            .from('agent_identifiers')
            .select('id_string, persons(first_name, last_name)')
            .in('id_string', chunk);
        (idents || []).forEach(ai => {
            if (ai.persons) partnerMap[ai.id_string] = `${ai.persons.first_name || ''} ${ai.persons.last_name || ''}`.trim();
        });
    }

    // 7. Build response
    const result = eligible.map(m => ({
        id: m.id,
        dba_name: m.dba_name,
        merchant_id: m.merchant_id,
        agent_id: m.agent_id,
        account_status: m.account_status,
        volume: m.volume,
        volume_30_day: m.volume_30_day,
        volume_mtd: m.volume_mtd,
        partner_name: partnerMap[m.agent_id] || null,
        current_equipment: currentByMerchant[m.id] || [],
        legacy_equipment:  legacyByMerchant[m.id]  || []
    }));

    return res.json({ success: true, data: result, total: result.length });
}

        // --- ACTION: ADD ATTACHMENT RECORD ---
        if (action === 'add_attachment') {
            const { merchant_id, file_name, file_path, file_type, file_size, uploaded_by } = req.body;

            const { data, error } = await supabase
                .from('merchant_attachments')
                .insert([{ merchant_id, file_name, file_path, file_type, file_size, uploaded_by }]);

            if (error) throw error;
            const { data: attachActorRow } = await supabase.from('app_users').select('email').eq('userid', session.userid).maybeSingle();
            supabase.from('activity_logs').insert({
                email: attachActorRow?.email || uploaded_by || session.userid, action: `File uploaded: ${file_name}`,
                status: 'success', category: 'merchants', target_id: merchant_id, target_type: 'merchant', severity: 'info',
                new_value: { file_name, file_type, file_size }
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true });
        }

        if (action === 'update_note') {
            const { note_id, title, body } = req.body;
            if (title && title.length > 200) return res.status(400).json({ success: false, message: 'Title too long (max 200 characters).' });
            if (body && body.length > 5000) return res.status(400).json({ success: false, message: 'Note too long (max 5000 characters).' });
            const { data: oldNote } = await supabase.from('merchant_notes').select('title, body, merchant_id, created_by').eq('id', note_id).maybeSingle();
            if (!oldNote) return res.status(404).json({ success: false, message: 'Note not found.' });
            const { data: noteActor } = await supabase.from('app_users').select('role').eq('userid', session.userid).maybeSingle();
            const noteIsAdmin = ['super_admin', 'Operations Admin'].includes(noteActor?.role);
            if (!noteIsAdmin && oldNote.created_by !== session.userid) {
                return res.status(403).json({ success: false, message: 'You can only edit notes you created.' });
            }
            const { error } = await supabase
                .from('merchant_notes')
                .update({ title, body, updated_at: new Date().toISOString(), updated_by: session.userid })
                .eq('id', note_id);

            if (error) throw error;
            const { data: noteActorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
            const noteActorEmail = noteActorRow?.email || session.userid;
            const noteActorName = noteActorRow ? `${noteActorRow.first_name || ''} ${noteActorRow.last_name || ''}`.trim() || noteActorRow.email : 'Staff';
            supabase.from('activity_logs').insert({
                email: noteActorEmail, action: `Merchant note updated by ${noteActorName}`,
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

            // Pre-fetch for audit log + ownership check
            const { data: attachRow } = await supabase.from('merchant_attachments').select('file_name, merchant_id, uploaded_by').eq('id', file_id).maybeSingle();
            if (!attachRow) return res.status(404).json({ success: false, message: 'Attachment not found.' });
            const { data: delActor } = await supabase.from('app_users').select('role').eq('userid', session.userid).maybeSingle();
            const delIsAdmin = ['super_admin', 'Operations Admin'].includes(delActor?.role);
            if (!delIsAdmin && attachRow.uploaded_by !== session.userid) {
                return res.status(403).json({ success: false, message: 'You can only delete files you uploaded.' });
            }
            const { data: delActorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
            const delActorEmail = delActorRow?.email || session.userid;
            const delActorName  = delActorRow ? `${delActorRow.first_name || ''} ${delActorRow.last_name || ''}`.trim() || delActorEmail : 'Staff';

            // Delete from Storage
            await supabase.storage.from('merchant-files').remove([file_path]);

            // Delete from Database
            const { error } = await supabase.from('merchant_attachments').delete().eq('id', file_id);
            if (error) throw error;

            supabase.from('activity_logs').insert({
                email: delActorEmail,
                action: `Attachment Deleted by ${delActorName} — ${attachRow?.file_name || file_path}`,
                status: 'success', category: 'merchants', target_id: file_id, target_type: 'attachment', severity: 'warning',
                old_value: { file_id, file_name: attachRow?.file_name, file_path, merchant_id: attachRow?.merchant_id },
                new_value: { deleted: true, deleted_by: delActorEmail }
            }).then(() => {}).catch(() => {});

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
        console.error('[API Error]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
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
        console.error('[API Error]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
    }
}
     if (action === 'update') {
    // 1. Validate ID
    if (!id) return res.status(400).json({ success: false, message: "Missing Merchant UUID" });

    // Always fetch current state for audit log old_value
    const { data: oldMerchant } = await supabase.from('merchants')
        .select('account_status, dba_name, merchant_id, agent_id, merchant_city, merchant_state, email, agent_name')
        .eq('id', id).maybeSingle();
    const oldStatus = oldMerchant; // kept for webhook compatibility below

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

    const { data: updActorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const updActorEmail = updActorRow?.email || session.userid;
    const updActorName = updActorRow ? `${updActorRow.first_name || ''} ${updActorRow.last_name || ''}`.trim() || updActorRow.email : 'Staff';

    const statusChanged = payload.account_status && oldMerchant?.account_status !== payload.account_status;
    const isSuspendOrTerminate = statusChanged && ['suspended', 'terminated', 'closed'].includes((payload.account_status || '').toLowerCase());
    const logSeverity = isSuspendOrTerminate ? 'critical' : statusChanged ? 'warning' : 'info';

    // Build old_value snapshot from only the fields being changed
    const oldSnapshot = {};
    for (const key of Object.keys(payload)) {
        if (oldMerchant && key in oldMerchant) oldSnapshot[key] = oldMerchant[key];
    }

    supabase.from('activity_logs').insert({
        email: updActorEmail,
        action: `Merchant Updated by ${updActorName} — ${oldMerchant?.dba_name || id} (${Object.keys(payload).join(', ')})`,
        status: 'success', category: 'merchants',
        target_id: oldMerchant?.merchant_id || id, target_type: 'merchant',
        severity: logSeverity,
        old_value: oldSnapshot,
        new_value: payload
    }).then(() => {}).catch(() => {});

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
        display_name: userMap[n.created_by] || n.created_by || 'Unknown Staff',
        updated_by_name: n.updated_by ? (userMap[n.updated_by] || n.updated_by) : null
    }));

    return res.status(200).json({ success: true, data: formattedData });
}
    if (action === 'add_note') {
    const { merchant_uuid, title, body, created_by, mentions } = req.body;
    if (title && title.length > 200) return res.status(400).json({ success: false, message: 'Title too long (max 200 characters).' });
    if (body && body.length > 5000) return res.status(400).json({ success: false, message: 'Note too long (max 5000 characters).' });
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

        // --- ACTION: get_pipeline_stats ---
        if (action === 'get_pipeline_stats') {
            let periodAgo, periodTo, recentLimit;
            if (req.body.date_from) {
                // Custom date range
                periodAgo = new Date(req.body.date_from).toISOString();
                periodTo  = req.body.date_to ? new Date(req.body.date_to).toISOString() : new Date().toISOString();
                const rangeDays = (new Date(periodTo) - new Date(periodAgo)) / 86400000;
                recentLimit = rangeDays <= 14 ? 20 : rangeDays <= 60 ? 40 : 80;
            } else {
                const periodDays = Math.min(Math.max(parseInt(req.body.period) || 7, 1), 730);
                periodAgo    = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();
                periodTo     = new Date().toISOString();
                recentLimit  = periodDays <= 7 ? 20 : periodDays <= 30 ? 40 : 80;
            }

            // Count queries (HEAD only — no row limit concerns, no data transferred)
            const countByStatus = (statusFilter, dateField) => {
                let q = supabase.from('merchants')
                    .select('*', { count: 'exact', head: true })
                    .eq('account_status', statusFilter)
                    .gte(dateField, periodAgo)
                    .lte(dateField, periodTo);
                return q;
            };

            const [
                stageRes,           // needs enrollment_date for avg_days — fetch rows, but small set
                cntEnrollPeriod, cntPendingPeriod, cntApprovedPeriod, cntDeclinedPeriod, cntWithdrawnPeriod,
                cntApprovedOutcome, cntDeclinedOutcome, cntWithdrawnOutcome,
                partnerRes,         // needs agent_name values to group — bounded by date filter
                recentRes
            ] = await Promise.all([
                // Active stage rows (Enrollment+Pending are always small — hundreds, not thousands)
                supabase.from('merchants')
                    .select('account_status, enrollment_date')
                    .in('account_status', ['Enrollment', 'Pending'])
                    .limit(10000),

                // Period entry counts per status (COUNT only, zero data transfer)
                countByStatus('Enrollment', 'enrollment_date'),
                countByStatus('Pending',    'enrollment_date'),
                countByStatus('Approved',   'enrollment_date'),
                countByStatus('Declined',   'enrollment_date'),
                countByStatus('Withdrawn',  'enrollment_date'),

                // Outcome counts based on status_change_date within range
                supabase.from('merchants').select('*', { count: 'exact', head: true })
                    .eq('account_status', 'Approved')
                    .gte('account_status_change_date', periodAgo)
                    .lte('account_status_change_date', periodTo)
                    .not('account_status_change_date', 'is', null),
                supabase.from('merchants').select('*', { count: 'exact', head: true })
                    .eq('account_status', 'Declined')
                    .gte('account_status_change_date', periodAgo)
                    .lte('account_status_change_date', periodTo)
                    .not('account_status_change_date', 'is', null),
                supabase.from('merchants').select('*', { count: 'exact', head: true })
                    .eq('account_status', 'Withdrawn')
                    .gte('account_status_change_date', periodAgo)
                    .lte('account_status_change_date', periodTo)
                    .not('account_status_change_date', 'is', null),

                // Top partners — needs agent_name values; bounded by date range
                supabase.from('merchants')
                    .select('agent_name')
                    .gte('enrollment_date', periodAgo)
                    .lte('enrollment_date', periodTo)
                    .not('agent_name', 'is', null)
                    .neq('agent_name', '')
                    .limit(200000),

                // Recent entries display list
                supabase.from('merchants')
                    .select('dba_name, merchant_id, agent_name, account_status, enrollment_date')
                    .gte('enrollment_date', periodAgo)
                    .lte('enrollment_date', periodTo)
                    .order('enrollment_date', { ascending: false })
                    .limit(recentLimit)
            ]);

            // Compute avg days per active stage from fetched rows
            const now = Date.now();
            const stageMap = {};
            for (const m of (stageRes.data || [])) {
                if (!stageMap[m.account_status]) stageMap[m.account_status] = { count: 0, totalDays: 0, validDays: 0 };
                stageMap[m.account_status].count++;
                if (m.enrollment_date) {
                    const days = (now - new Date(m.enrollment_date).getTime()) / 86400000;
                    if (days >= 0 && days < 3650) {
                        stageMap[m.account_status].totalDays += days;
                        stageMap[m.account_status].validDays++;
                    }
                }
            }
            const stages = Object.entries(stageMap).map(([status, s]) => ({
                status,
                count: s.count,
                avg_days: s.validDays > 0 ? Math.round(s.totalDays / s.validDays) : null
            }));

            // Period entry counts (from COUNT queries)
            const periodCounts = {
                Enrollment: cntEnrollPeriod.count  || 0,
                Pending:    cntPendingPeriod.count  || 0,
                Approved:   cntApprovedPeriod.count || 0,
                Declined:   cntDeclinedPeriod.count || 0,
                Withdrawn:  cntWithdrawnPeriod.count|| 0,
            };

            // Outcome counts & conversion rate
            const approvedPeriod = cntApprovedOutcome.count || 0;
            const declinedPeriod = (cntDeclinedOutcome.count || 0) + (cntWithdrawnOutcome.count || 0);
            const conversionRate = (approvedPeriod + declinedPeriod) > 0
                ? Math.round((approvedPeriod / (approvedPeriod + declinedPeriod)) * 100) : null;

            // Top partners by submission volume
            const partnerCounts = {};
            for (const m of (partnerRes.data || [])) {
                partnerCounts[m.agent_name] = (partnerCounts[m.agent_name] || 0) + 1;
            }
            const topPartners = Object.entries(partnerCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([name, count]) => ({ name, count }));

            return res.status(200).json({
                success: true,
                stages,
                period_counts: periodCounts,
                approved_period: approvedPeriod,
                declined_period: declinedPeriod,
                conversion_rate: conversionRate,
                top_partners: topPartners,
                recent: recentRes.data || []
            });
        }

        if (action === 'get_prime49_residuals') {
            // Include both Approved and Approved - Collections (still actively processing)
            const { data, error } = await supabase
                .from('merchant_portfolio_view')
                .select('merchant_id, dba_name, volume_30_day, agent_id, partner_full_name, company_display_name, account_status')
                .eq('is_prime49', true)
                .in('account_status', ['Approved', 'Approved - Collections'])
                .order('dba_name', { ascending: true })
                .limit(10000);

            if (error) throw error;

            // Enrich with rev_share from agent_identifiers (explicit limit to avoid default 1000 cap)
            const agentIds = [...new Set((data || []).map(m => m.agent_id).filter(Boolean))];
            let revShareMap = {};
            if (agentIds.length) {
                const { data: aiData } = await supabase
                    .from('agent_identifiers')
                    .select('id_string, rev_share')
                    .in('id_string', agentIds)
                    .limit(10000);
                (aiData || []).forEach(ai => { revShareMap[ai.id_string] = ai.rev_share; });
            }

            const rows = (data || []).map(m => {
                const vol = parseFloat(m.volume_30_day) || 0;
                const rawRev = revShareMap[m.agent_id];
                const revPct = rawRev ? parseFloat(String(rawRev).replace(/%/g, '')) : 50;
                const agentResidual = vol * 0.015;
                const netResidual   = agentResidual * 2;
                const pptResidual   = netResidual * (1 - revPct / 100);
                const agentActual   = netResidual * (revPct / 100);
                return {
                    dba_name:        m.dba_name,
                    merchant_id:     m.merchant_id,
                    account_status:  m.account_status,
                    volume_30_day:   vol,
                    agent_id:        m.agent_id,
                    agent_name:      m.partner_full_name || '—',
                    agent_company:   m.company_display_name || '—',
                    rev_share:       revPct,
                    net_residual:    netResidual,
                    ppt_residual:    pptResidual,
                    agent_residual:  agentActual,
                };
            });

            // Fire-and-forget audit log — don't delay the response
            supabase.from('app_users').select('email').eq('userid', session.userid).single().then(({ data: actor }) => {
                supabase.from('activity_logs').insert([{
                    email: actor?.email || session.userid,
                    action: 'Prime49 Residuals Report Loaded',
                    status: 'success',
                    category: 'merchants',
                    target_type: 'report',
                    severity: 'info',
                    new_value: { merchant_count: rows.length, partner_count: [...new Set(rows.map(r => r.agent_name))].length, generated_at: new Date().toISOString() },
                    user_agent: req.headers['user-agent'],
                    ip_address: req.headers['x-forwarded-for'] || 'Internal'
                }]);
            });

            // Fetch ALL prime49 identifiers (including those with no approved merchants)
            const { data: allP49Ids } = await supabase
                .from('agent_identifiers')
                .select('id_string, rev_share, agent_id')
                .eq('prime49', true)
                .limit(10000);

            const allAgentIdSet = [...new Set((allP49Ids || []).map(r => r.agent_id).filter(Boolean))];
            let agentInfoMap = {};
            if (allAgentIdSet.length) {
                const { data: agentRows } = await supabase
                    .from('agents')
                    .select('id, agent_name, company_id')
                    .in('id', allAgentIdSet)
                    .limit(10000);
                (agentRows || []).forEach(a => { agentInfoMap[a.id] = a; });
            }
            const companyIdSet = [...new Set(Object.values(agentInfoMap).map(a => a.company_id).filter(Boolean))];
            let companyNameMap = {};
            if (companyIdSet.length) {
                const { data: companyRows } = await supabase
                    .from('companies')
                    .select('id, company_name')
                    .in('id', companyIdSet);
                (companyRows || []).forEach(c => { companyNameMap[c.id] = c.company_name; });
            }
            const allPrime49Partners = (allP49Ids || []).map(p => {
                const ag = agentInfoMap[p.agent_id] || {};
                return {
                    id_string:     p.id_string,
                    rev_share:     parseFloat(String(p.rev_share || '50').replace(/%/g, '')) || 50,
                    agent_name:    ag.agent_name || '—',
                    agent_company: companyNameMap[ag.company_id] || '—'
                };
            });

            return res.status(200).json({ success: true, data: rows, all_prime49_partners: allPrime49Partners });
        }

        // ── MERCHANT MERGE ────────────────────────────────────────────────────────
        if (action === 'scan_scientific_mids') {
            const { data: scanActor } = await supabase.from('app_users').select('role').eq('userid', session.userid).single();
            if (scanActor?.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super Admin only.' });
            const { data: sciData, error: sciErr } = await supabase
                .from('merchants')
                .select('id, merchant_id, dba_name, account_status, agent_name, created_at')
                .or('merchant_id.ilike.%E+%,merchant_id.ilike.%e+%')
                .order('created_at', { ascending: false });
            if (sciErr) throw sciErr;
            return res.status(200).json({ success: true, data: sciData || [] });
        }

        if (action === 'search_for_merge') {
            const { q } = req.body;
            if (!q || q.trim().length < 2) return res.status(400).json({ success: false, message: 'Query too short.' });
            const safe = q.trim();
            const { data, error: searchErr } = await supabase
                .from('merchants')
                .select('id, merchant_id, dba_name, account_status, agent_name')
                .or(`dba_name.ilike.%${safe}%,merchant_id.ilike.%${safe}%`)
                .order('dba_name')
                .limit(10);
            if (searchErr) throw searchErr;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'get_merge_preview') {
            const { source_id, target_id } = req.body;
            if (!source_id || !target_id) return res.status(400).json({ success: false, message: 'source_id and target_id required.' });
            if (source_id === target_id) return res.status(400).json({ success: false, message: 'Source and target must be different merchants.' });

            const { data: mergeActor } = await supabase.from('app_users').select('role').eq('userid', session.userid).single();
            if (mergeActor?.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super Admin only.' });

            const [srcRes, tgtRes] = await Promise.all([
                supabase.from('merchants').select('id, merchant_id, dba_name, account_status, agent_name').eq('id', source_id).single(),
                supabase.from('merchants').select('id, merchant_id, dba_name, account_status, agent_name').eq('id', target_id).single()
            ]);
            if (!srcRes.data) return res.status(404).json({ success: false, message: 'Source merchant not found.' });
            if (!tgtRes.data) return res.status(404).json({ success: false, message: 'Target merchant not found.' });

            const [notes, tasks, attachments, deps, rets, eqLogs, rmaReqs, tickets] = await Promise.all([
                supabase.from('merchant_notes').select('id', { count: 'exact', head: true }).eq('merchant_id', source_id),
                supabase.from('merchant_tasks').select('id', { count: 'exact', head: true }).eq('merchant_id', source_id),
                supabase.from('merchant_attachments').select('id', { count: 'exact', head: true }).eq('merchant_id', source_id),
                supabase.from('deployments').select('id', { count: 'exact', head: true }).eq('merchant_id', source_id),
                supabase.from('returns').select('id', { count: 'exact', head: true }).eq('merchant_id', source_id),
                supabase.from('equipment_logs').select('id', { count: 'exact', head: true }).eq('merchant_id', source_id),
                supabase.from('partner_rma_requests').select('id', { count: 'exact', head: true }).eq('merchant_id', source_id),
                supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('merchant_id', srcRes.data.merchant_id),
            ]);

            return res.status(200).json({
                success: true,
                source: srcRes.data,
                target: tgtRes.data,
                preview: {
                    notes: notes.count || 0,
                    tasks: tasks.count || 0,
                    attachments: attachments.count || 0,
                    deployments: deps.count || 0,
                    returns: rets.count || 0,
                    equipment_logs: eqLogs.count || 0,
                    rma_requests: rmaReqs.count || 0,
                    support_tickets: tickets.count || 0,
                }
            });
        }

        if (action === 'merge_merchants') {
            const { source_id, target_id } = req.body;
            if (!source_id || !target_id) return res.status(400).json({ success: false, message: 'source_id and target_id required.' });
            if (source_id === target_id) return res.status(400).json({ success: false, message: 'Cannot merge a merchant with itself.' });

            const { data: mergeActor2 } = await supabase.from('app_users').select('role, email, first_name, last_name').eq('userid', session.userid).single();
            if (mergeActor2?.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super Admin only.' });

            const [srcRes2, tgtRes2] = await Promise.all([
                supabase.from('merchants').select('id, merchant_id, dba_name, account_status, agent_name').eq('id', source_id).single(),
                supabase.from('merchants').select('id, merchant_id, dba_name, account_status, agent_name').eq('id', target_id).single()
            ]);
            if (!srcRes2.data) return res.status(404).json({ success: false, message: 'Source merchant not found.' });
            if (!tgtRes2.data) return res.status(404).json({ success: false, message: 'Target merchant not found.' });

            const src2 = srcRes2.data, tgt2 = tgtRes2.data;
            const transferred = {};

            // Re-point all UUID FK tables
            const uuidTables = ['merchant_notes', 'merchant_tasks', 'merchant_attachments', 'deployments', 'returns', 'equipment_logs', 'partner_rma_requests', 'equipments', 'legacy_deployments'];
            for (const tbl of uuidTables) {
                const { count } = await supabase.from(tbl).select('id', { count: 'exact', head: true }).eq('merchant_id', source_id);
                if (count > 0) await supabase.from(tbl).update({ merchant_id: target_id }).eq('merchant_id', source_id);
                transferred[tbl] = count || 0;
            }

            // Re-point support_tickets (FK → merchants.merchant_id string MID)
            const { count: ticketCount } = await supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('merchant_id', src2.merchant_id);
            if (ticketCount > 0) await supabase.from('support_tickets').update({ merchant_id: tgt2.merchant_id }).eq('merchant_id', src2.merchant_id);
            transferred.support_tickets = ticketCount || 0;

            // Add merge system note to target
            const actorName2 = `${mergeActor2.first_name || ''} ${mergeActor2.last_name || ''}`.trim() || mergeActor2.email;
            await supabase.from('merchant_notes').insert({
                merchant_id: target_id,
                title: 'Merchant Merge — System Record',
                body: `Merged from duplicate record.\n\nSource: ${src2.dba_name} (MID: ${src2.merchant_id})\nMerged by: ${actorName2}\nDate: ${new Date().toISOString().split('T')[0]}\n\nAll notes, tasks, attachments, deployments, returns, equipment logs, and tickets from the duplicate have been transferred to this record.`,
                created_by: session.userid
            });

            // Delete source merchant
            await supabase.from('merchants').delete().eq('id', source_id);

            // Activity log
            await supabase.from('activity_logs').insert([{
                email: mergeActor2.email,
                action: `Merchant Merge: "${src2.dba_name}" (${src2.merchant_id}) → "${tgt2.dba_name}" (${tgt2.merchant_id})`,
                status: 'success', category: 'merchants', severity: 'warning',
                target_id: target_id, target_type: 'merchant',
                new_value: {
                    source: { id: source_id, merchant_id: src2.merchant_id, dba_name: src2.dba_name },
                    target: { id: target_id, merchant_id: tgt2.merchant_id, dba_name: tgt2.dba_name },
                    records_transferred: transferred, merged_by: actorName2
                }
            }]);

            return res.status(200).json({ success: true, records_transferred: transferred, target: tgt2 });
        }

        // ── LEGACY ATTACHMENTS ────────────────────────────────────────────────

        if (action === 'get_legacy_attachments') {
            const { offset = 0, limit: reqLimit = 50, search: fileSearch = '' } = req.body;
            const PAGE = Math.min(parseInt(reqLimit) || 50, 100);
            const OFF  = parseInt(offset) || 0;
            let q = supabase.from('legacy_attachments').select('*', { count: 'exact' })
                .is('merchant_id', null)
                .order('created_at', { ascending: false })
                .range(OFF, OFF + PAGE - 1);
            if (fileSearch) q = q.ilike('file_name', `%${fileSearch}%`);
            const { data, error, count } = await q;
            if (error) throw error;
            return res.status(200).json({ success: true, attachments: data || [], total: count || 0, offset: OFF, limit: PAGE });
        }

        if (action === 'add_legacy_attachment') {
            const { file_name, file_path, file_type, file_size } = req.body;
            if (!file_name || !file_path) return res.status(400).json({ success: false, message: 'file_name and file_path required' });
            const actor = await supabase.from('app_users').select('email').eq('userid', session.userid).maybeSingle();
            const actorEmail = actor.data?.email || session.userid;
            const { data, error } = await supabase.from('legacy_attachments').insert({
                file_name, file_path, file_type, file_size,
                uploaded_by: actorEmail,
            }).select().single();
            if (error) throw error;
            const fileSizeMB = file_size ? (file_size / 1048576).toFixed(2) + ' MB' : 'unknown size';
            supabase.from('activity_logs').insert({
                email: actorEmail,
                action: `Legacy file uploaded: "${file_name}" (${file_type || 'unknown type'}, ${fileSizeMB}) — unassigned, pending merchant assignment`,
                status: 'success',
                category: 'merchants',
                target_id: data?.id,
                target_type: 'legacy_attachment',
                severity: 'info',
                new_value: { file_name, file_path, file_type, file_size, uploaded_by: actorEmail, attachment_id: data?.id }
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true, attachment: data });
        }

        if (action === 'delete_legacy_attachment') {
            const { file_id, file_path } = req.body;
            if (!file_id) return res.status(400).json({ success: false, message: 'file_id required' });
            const { data: delRow } = await supabase.from('legacy_attachments').select('file_name, file_type, file_size, uploaded_by').eq('id', file_id).maybeSingle();
            const delActor = await supabase.from('app_users').select('email').eq('userid', session.userid).maybeSingle();
            const delActorEmail = delActor.data?.email || session.userid;
            if (file_path) {
                await supabase.storage.from('merchant-files').remove([file_path]);
            }
            const { error } = await supabase.from('legacy_attachments').delete().eq('id', file_id);
            if (error) throw error;
            supabase.from('activity_logs').insert({
                email: delActorEmail,
                action: `Legacy file deleted: "${delRow?.file_name || file_id}" — permanently removed from storage and legacy queue`,
                status: 'success',
                category: 'merchants',
                target_id: file_id,
                target_type: 'legacy_attachment',
                severity: 'warning',
                old_value: { file_id, file_name: delRow?.file_name, file_path, file_type: delRow?.file_type, file_size: delRow?.file_size, originally_uploaded_by: delRow?.uploaded_by }
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true });
        }

        if (action === 'search_merchants_for_legacy') {
            const q = (req.body.query || '').trim();
            if (!q) return res.status(200).json({ success: true, merchants: [] });
            const { data, error } = await supabase
                .from('merchants')
                .select('id, merchant_id, dba_name, account_status')
                .or(`merchant_id.ilike.%${q}%,dba_name.ilike.%${q}%`)
                .limit(25);
            if (error) throw error;
            return res.status(200).json({ success: true, merchants: data || [] });
        }

        if (action === 'assign_legacy_attachment') {
            const { file_id, merchant_uuid } = req.body;
            if (!file_id || !merchant_uuid) return res.status(400).json({ success: false, message: 'file_id and merchant_uuid required' });
            const { data: legRow, error: e1 } = await supabase.from('legacy_attachments').select('*').eq('id', file_id).single();
            if (e1 || !legRow) return res.status(404).json({ success: false, message: 'Legacy attachment not found' });
            const [actorRes, merchantRes] = await Promise.all([
                supabase.from('app_users').select('email').eq('userid', session.userid).maybeSingle(),
                supabase.from('merchants').select('merchant_id, dba_name').eq('id', merchant_uuid).maybeSingle(),
            ]);
            const actorEmail = actorRes.data?.email || session.userid;
            const merchantLabel = merchantRes.data
                ? `${merchantRes.data.dba_name} (${merchantRes.data.merchant_id})`
                : merchant_uuid;
            // Copy into merchant_attachments
            const { error: e2 } = await supabase.from('merchant_attachments').insert({
                merchant_id: merchant_uuid,
                file_name: legRow.file_name,
                file_path: legRow.file_path,
                file_type: legRow.file_type,
                file_size: legRow.file_size,
                uploaded_by: legRow.uploaded_by,
            });
            if (e2) throw e2;
            // Remove from legacy_attachments
            await supabase.from('legacy_attachments').delete().eq('id', file_id);
            const fileSizeMB = legRow.file_size ? (legRow.file_size / 1048576).toFixed(2) + ' MB' : 'unknown size';
            supabase.from('activity_logs').insert({
                email: actorEmail,
                action: `Legacy file assigned to merchant: "${legRow.file_name}" → ${merchantLabel} — originally uploaded by ${legRow.uploaded_by || 'unknown'}, moved from legacy queue to merchant attachments`,
                status: 'success',
                category: 'merchants',
                target_id: merchantRes.data?.merchant_id || merchant_uuid,
                target_type: 'merchant',
                severity: 'info',
                new_value: {
                    file_name: legRow.file_name,
                    file_path: legRow.file_path,
                    file_type: legRow.file_type,
                    file_size: legRow.file_size,
                    file_size_readable: fileSizeMB,
                    assigned_to_merchant_uuid: merchant_uuid,
                    assigned_to_merchant_id: merchantRes.data?.merchant_id,
                    assigned_to_dba_name: merchantRes.data?.dba_name,
                    originally_uploaded_by: legRow.uploaded_by,
                    assigned_by: actorEmail,
                    legacy_attachment_id: file_id,
                }
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: "Unknown action" });
    } catch (err) {
        console.error('[API Error]', err.message, err.details || '', err.hint || '');
        return res.status(500).json({ success: false, message: err.message || 'An unexpected error occurred. Please try again.' });
    }
} // End of handler function
