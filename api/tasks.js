import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, userid, staff_name } = req.body;

    try {
        // ── GET TASKS ─────────────────────────────────────
        if (action === 'get_tasks') {
            const { view = 'mine', status, priority, assigned_to, page = 0, limit = 25 } = req.body;

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

            // View filter
            if (view === 'mine') query = query.eq('assigned_to', userid);
            else if (view === 'created') query = query.eq('created_by', userid);
            else if (view === 'all') { /* no filter — super admin sees everything */ }

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
                created_by: userid,
                status: 'Pending'
            }).select().single();

            if (error) throw error;

            // Log it
            await supabase.from('activity_logs').insert({
                email: staff_name || userid, action: `Created task: ${title}`,
                status: 'success', category: 'tasks',
                target_id: data.id, target_type: 'task'
            });

            return res.status(200).json({ success: true, data });
        }

        // ── UPDATE TASK ───────────────────────────────────
        if (action === 'update_task') {
            const { task_id, payload } = req.body;
            const { error } = await supabase.from('merchant_tasks').update(payload).eq('id', task_id);
            if (error) throw error;

            await supabase.from('activity_logs').insert({
                email: staff_name || userid, action: `Updated task`,
                status: 'success', category: 'tasks',
                target_id: task_id, target_type: 'task'
            });

            return res.status(200).json({ success: true });
        }

        // ── DELETE TASK ───────────────────────────────────
        if (action === 'delete_task') {
            const { task_id } = req.body;
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

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('Tasks API error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
