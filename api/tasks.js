import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, userid, staff_name } = req.body;

    // Actor permissions — drive granular access to the org-wide task views.
    const { data: me } = await supabase.from('app_users')
        .select('role, access_all_tasks, access_task_dashboard').eq('userid', session.userid).maybeSingle();
    const roleStr = String(me?.role || '').toLowerCase();
    const isAdmin = roleStr.indexOf('super') !== -1 || roleStr.indexOf('admin') !== -1;
    const canSeeAll = isAdmin || me?.access_all_tasks === true;
    const canDashboard = isAdmin || me?.access_task_dashboard === true;

    try {
        // ── GET TASKS ─────────────────────────────────────
        if (action === 'get_tasks') {
            let { view = 'mine', status, priority, assigned_to, page = 0, limit = 25 } = req.body;
            // Org-wide views require permission; otherwise fall back to the caller's own tasks.
            if ((view === 'all' || assigned_to) && !canSeeAll) { view = 'mine'; assigned_to = undefined; }

            let query = supabase
                .from('merchant_tasks')
                .select(`
                    id, title, body, status, priority, due_date, created_at, notes,
                    assigned_to, created_by,
                    merchants:merchant_id (id, dba_name, merchant_id)
                `, { count: 'exact' })
                .order('priority', { ascending: false })
                .order('due_date', { ascending: true })
                .range(page * limit, (page + 1) * limit - 1);

            // View filter (use the authenticated user for own-scoped views)
            if (view === 'mine') query = query.eq('assigned_to', session.userid);
            else if (view === 'created') query = query.eq('created_by', session.userid);
            else if (view === 'all') { /* permitted above via canSeeAll */ }

            if (status) query = query.eq('status', status);
            if (priority) query = query.eq('priority', priority);
            if (assigned_to) query = query.eq('assigned_to', assigned_to);

            const { data, count, error } = await query;
            if (error) throw error;

            // Get staff names for assigned_to and created_by
            const staffIds = [...new Set([
                ...(data||[]).map(t => t.assigned_to).filter(Boolean),
                ...(data||[]).map(t => t.created_by).filter(Boolean)
            ])];

            let staffMap = {};
            if (staffIds.length) {
                const { data: staff } = await supabase
                    .from('app_users')
                    .select('userid, first_name, last_name')
                    .in('userid', staffIds);
                (staff||[]).forEach(s => staffMap[s.userid] = `${s.first_name} ${s.last_name||''}`.trim());
            }

            const enriched = (data||[]).map(t => ({
                ...t,
                assigned_to_name: staffMap[t.assigned_to] || 'Unassigned',
                created_by_name: staffMap[t.created_by] || 'Unknown',
                is_overdue: t.due_date && new Date(t.due_date) < new Date() && t.status !== 'Completed'
            }));

            return res.status(200).json({ success: true, data: enriched, count: count || 0 });
        }

        // ── CREATE TASK ───────────────────────────────────
        if (action === 'create_task') {
            const { title, body, merchant_id, assigned_to, due_date, priority = 'Normal', notes } = req.body;
            if (!title || !merchant_id) return res.status(400).json({ success: false, message: 'Title and merchant required.' });

            const { data, error } = await supabase.from('merchant_tasks').insert({
                title, body, merchant_id, assigned_to, due_date, priority, notes,
                created_by: session.userid,
                status: 'Pending'
            }).select().single();

            if (error) throw error;

            // Log it
            await supabase.from('activity_logs').insert({
                email: staff_name || userid, action: `Created task: ${title}`,
                status: 'success', category: 'tasks',
                target_id: data.id, target_type: 'task',
                new_value: { title, body, merchant_id, assigned_to, due_date, priority }
            });

            return res.status(200).json({ success: true, data });
        }

        // ── UPDATE TASK ───────────────────────────────────
        if (action === 'update_task') {
            const { task_id, payload } = req.body;
            const { data: oldTask } = await supabase.from('merchant_tasks').select('title, status, assigned_to, priority, due_date, created_by').eq('id', task_id).maybeSingle();
            if (!oldTask) return res.status(404).json({ success: false, message: 'Task not found.' });

            const { data: actor } = await supabase.from('app_users').select('role').eq('userid', session.userid).maybeSingle();
            const isAdmin = ['super_admin', 'Operations Admin'].includes(actor?.role);
            if (!isAdmin && oldTask.created_by !== session.userid && oldTask.assigned_to !== session.userid) {
                return res.status(403).json({ success: false, message: 'You can only edit tasks you created or are assigned to.' });
            }

            const ALLOWED_TASK_FIELDS = ['title', 'body', 'status', 'priority', 'due_date', 'notes', 'assigned_to'];
            const patch = {};
            for (const k of ALLOWED_TASK_FIELDS) { if (k in payload) patch[k] = payload[k]; }

            // Track completion time for the daily digest's "completed yesterday" list.
            if ('status' in patch) {
                if (patch.status === 'Completed' && oldTask.status !== 'Completed') patch.completed_at = new Date().toISOString();
                else if (patch.status !== 'Completed') patch.completed_at = null;   // reopened
            }

            const { error } = await supabase.from('merchant_tasks').update(patch).eq('id', task_id);
            if (error) throw error;

            await supabase.from('activity_logs').insert({
                email: staff_name || userid, action: `Updated task: ${oldTask?.title || task_id}`,
                status: 'success', category: 'tasks',
                target_id: task_id, target_type: 'task',
                old_value: { status: oldTask.status, assigned_to: oldTask.assigned_to, priority: oldTask.priority, due_date: oldTask.due_date },
                new_value: patch
            });

            return res.status(200).json({ success: true });
        }

        // ── DELETE TASK ───────────────────────────────────
        if (action === 'delete_task') {
            const { task_id } = req.body;
            const { data: task } = await supabase.from('merchant_tasks').select('created_by').eq('id', task_id).maybeSingle();
            if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

            const { data: actor } = await supabase.from('app_users').select('role').eq('userid', session.userid).maybeSingle();
            const isAdmin = ['super_admin', 'Operations Admin'].includes(actor?.role);
            if (!isAdmin && task.created_by !== session.userid) {
                return res.status(403).json({ success: false, message: 'You can only delete tasks you created.' });
            }

            await supabase.from('task_comments').delete().eq('task_id', task_id);
            await supabase.from('merchant_tasks').delete().eq('id', task_id);
            return res.status(200).json({ success: true });
        }

        // ── GET COMMENTS ──────────────────────────────────
        if (action === 'get_comments') {
            const { task_id } = req.body;
            const { data } = await supabase.from('task_comments').select('*').eq('task_id', task_id).order('created_at');

            const staffIds = [...new Set((data||[]).map(c => c.author_id))];
            let staffMap = {};
            if (staffIds.length) {
                const { data: staff } = await supabase.from('app_users').select('userid, first_name, last_name').in('userid', staffIds);
                (staff||[]).forEach(s => staffMap[s.userid] = `${s.first_name} ${s.last_name||''}`.trim());
            }

            return res.status(200).json({ success: true, data: (data||[]).map(c => ({ ...c, author_name: staffMap[c.author_id] || 'Unknown' })) });
        }

        // ── ADD COMMENT ───────────────────────────────────
        if (action === 'add_comment') {
            const { task_id, body: commentBody } = req.body;
            await supabase.from('task_comments').insert({ task_id, author_id: userid, body: commentBody });
            return res.status(200).json({ success: true });
        }

        // ── GET STAFF LIST ────────────────────────────────
        if (action === 'get_staff') {
            const { data } = await supabase.from('app_users').select('userid, first_name, last_name').eq('is_active', true).order('first_name');
            return res.status(200).json({ success: true, data: (data||[]).map(s => ({ id: s.userid, full_name: `${s.first_name} ${s.last_name||''}`.trim() })) });
        }

        // ── GET TASK STATS ────────────────────────────────
        if (action === 'get_stats') {
            const [mine, overdue, all] = await Promise.all([
                supabase.from('merchant_tasks').select('*', { count: 'exact', head: true }).eq('assigned_to', userid).eq('status', 'Pending'),
                supabase.from('merchant_tasks').select('*', { count: 'exact', head: true }).eq('assigned_to', userid).eq('status', 'Pending').lt('due_date', new Date().toISOString().split('T')[0]),
                supabase.from('merchant_tasks').select('*', { count: 'exact', head: true }).eq('status', 'Pending')
            ]);
            return res.status(200).json({ success: true, mine: mine.count||0, overdue: overdue.count||0, all: all.count||0 });
        }

        // ── TASK DASHBOARD (analytics + leaderboard) ──────
        if (action === 'task_dashboard') {
            if (!canDashboard) return res.status(403).json({ success: false, message: 'You do not have access to the Task Dashboard.' });

            const todayStr = new Date().toISOString().split('T')[0];
            const now = new Date();
            const weekAgoIso = new Date(now.getTime() - 7 * 864e5).toISOString();
            // Leaderboard period for the "completed" metric.
            const period = ['7d', 'month', 'all'].includes(req.body.period) ? req.body.period : '7d';
            const periodStartIso = period === 'all' ? null
                : period === 'month' ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
                : weekAgoIso;

            // Pull the fields we need for every task (bounded high). Aggregate in JS.
            let rows = [];
            let from = 0; const PAGE = 1000;
            while (true) {
                const { data, error } = await supabase.from('merchant_tasks')
                    .select('status, priority, due_date, assigned_to, completed_at')
                    .range(from, from + PAGE - 1);
                if (error) throw error;
                if (!data || !data.length) break;
                rows = rows.concat(data);
                if (data.length < PAGE) break;
                from += PAGE;
            }

            const byStatus = { Pending: 0, Completed: 0 };
            const byPriority = { High: 0, Normal: 0, Low: 0 };
            let overdue = 0, completedThisWeek = 0, unassigned = 0;
            let completedInPeriod = 0;
            const board = {};   // userid -> { pending, completed, overdue, completed_period }
            const bump = (uid, k) => { if (!uid) { if (k === 'pending') unassigned++; return; } (board[uid] = board[uid] || { pending: 0, completed: 0, overdue: 0, completed_period: 0 })[k]++; };

            rows.forEach(t => {
                byStatus[t.status] = (byStatus[t.status] || 0) + 1;
                if (t.priority && byPriority[t.priority] != null) byPriority[t.priority]++;
                if (t.status === 'Pending') {
                    bump(t.assigned_to, 'pending');
                    if (t.due_date && t.due_date < todayStr) { overdue++; bump(t.assigned_to, 'overdue'); }
                } else if (t.status === 'Completed') {
                    bump(t.assigned_to, 'completed');
                    if (t.completed_at && t.completed_at >= weekAgoIso) completedThisWeek++;
                    // Completions counted for the selected leaderboard period.
                    const inPeriod = !periodStartIso || (t.completed_at && t.completed_at >= periodStartIso);
                    if (inPeriod) { completedInPeriod++; bump(t.assigned_to, 'completed_period'); }
                }
            });

            // Names for the leaderboard.
            const ids = Object.keys(board);
            const names = {};
            if (ids.length) {
                const { data: staff } = await supabase.from('app_users').select('userid, first_name, last_name').in('userid', ids);
                (staff || []).forEach(s => { names[s.userid] = `${s.first_name || ''} ${s.last_name || ''}`.trim(); });
            }
            const leaderboard = ids.map(uid => ({
                user_id: uid, name: names[uid] || 'Unknown',
                ...board[uid]
            })).sort((a, b) => (b.completed_period - a.completed_period) || (b.completed - a.completed) || (a.pending - b.pending));

            return res.status(200).json({
                success: true,
                period,
                totals: {
                    total: rows.length,
                    pending: byStatus.Pending || 0,
                    completed: byStatus.Completed || 0,
                    overdue, completed_this_week: completedThisWeek,
                    completed_in_period: completedInPeriod, unassigned
                },
                by_priority: byPriority,
                leaderboard
            });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('Tasks API error:', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
    }
}
