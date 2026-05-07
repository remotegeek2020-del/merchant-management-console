import { createClient } from '@supabase/supabase-js';

async function isSuperAdmin(supabase, userid) {
    if (!userid) return false;
    const { data } = await supabase.from('app_users').select('role, is_active').eq('userid', userid).single();
    return data?.is_active === true && data?.role === 'super_admin';
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body;

    try {
        if (action === 'list') {
            const { data, error } = await supabase
                .from('feature_ideas')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, ideas: data || [] });
        }

        if (action === 'add') {
            const { title, body, requested_by_userid, requested_by_name } = req.body;
            if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required.' });
            if (!body?.trim()) return res.status(400).json({ success: false, message: 'Description is required.' });
            if (!requested_by_userid) return res.status(400).json({ success: false, message: 'User ID is required.' });
            const { data, error } = await supabase
                .from('feature_ideas')
                .insert({ title: title.trim(), body: body.trim(), requested_by_userid, requested_by_name })
                .select()
                .single();
            if (error) throw error;
            return res.status(200).json({ success: true, idea: data });
        }

        if (action === 'update_status') {
            const { id, status } = req.body;
            const allowed = ['pending', 'in_progress', 'done', 'rejected'];
            if (!id) return res.status(400).json({ success: false, message: 'ID is required.' });
            if (!allowed.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
            const { error } = await supabase
                .from('feature_ideas')
                .update({ status, updated_at: new Date().toISOString() })
                .eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'delete') {
            const { id } = req.body;
            if (!id) return res.status(400).json({ success: false, message: 'ID is required.' });
            const { error } = await supabase.from('feature_ideas').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // ── DEV ACTIVITY — list (all staff) ──────────────────────────────────
        if (action === 'dev_activity_list') {
            const { data, error } = await supabase
                .from('dev_activities')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, activities: data || [] });
        }

        // ── DEV ACTIVITY — add (super_admin only) ────────────────────────────
        if (action === 'dev_activity_add') {
            const { userid, title, body, tag, posted_by_name } = req.body;
            if (!(await isSuperAdmin(supabase, userid))) return res.status(403).json({ success: false, message: 'Access denied.' });
            if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required.' });
            if (!body?.trim())  return res.status(400).json({ success: false, message: 'Details are required.' });
            const allowed = ['completed', 'in_progress', 'planned', 'fix', 'update'];
            const safeTag = allowed.includes(tag) ? tag : 'update';
            const { data, error } = await supabase
                .from('dev_activities')
                .insert({ title: title.trim(), body: body.trim(), tag: safeTag, posted_by_userid: userid, posted_by_name: posted_by_name || 'Dev' })
                .select().single();
            if (error) throw error;
            return res.status(200).json({ success: true, activity: data });
        }

        // ── DEV ACTIVITY — delete (super_admin only) ─────────────────────────
        if (action === 'dev_activity_delete') {
            const { userid, id } = req.body;
            if (!(await isSuperAdmin(supabase, userid))) return res.status(403).json({ success: false, message: 'Access denied.' });
            if (!id) return res.status(400).json({ success: false, message: 'ID is required.' });
            const { error } = await supabase.from('dev_activities').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (err) {
        console.error('Ideas API Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
