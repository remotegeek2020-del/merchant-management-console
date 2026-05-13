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
            const { userid } = req.body;
            const { data, error } = await supabase
                .from('feature_ideas')
                .select('*, idea_comments(id)')
                .order('votes', { ascending: false })
                .order('created_at', { ascending: false });
            if (error) throw error;

            // Fetch which ideas this user has voted on
            let votedSet = new Set();
            if (userid) {
                const { data: votes } = await supabase
                    .from('idea_votes').select('idea_id').eq('userid', userid);
                votedSet = new Set((votes || []).map(v => v.idea_id));
            }

            const ideas = (data || []).map(i => ({
                ...i,
                voted_by_me: votedSet.has(i.id),
                comment_count: Array.isArray(i.idea_comments) ? i.idea_comments.length : 0,
                idea_comments: undefined
            }));
            return res.status(200).json({ success: true, ideas });
        }

        if (action === 'vote') {
            const { id, userid } = req.body;
            if (!id || !userid) return res.status(400).json({ success: false, message: 'ID and userid are required.' });

            // Check if already voted
            const { data: existing } = await supabase
                .from('idea_votes').select('idea_id').eq('idea_id', id).eq('userid', userid).maybeSingle();

            if (existing) {
                await supabase.from('idea_votes').delete().eq('idea_id', id).eq('userid', userid);
                await supabase.rpc('decrement_idea_votes', { idea_id: id });
                const { data: updated } = await supabase.from('feature_ideas').select('votes').eq('id', id).single();
                return res.status(200).json({ success: true, voted: false, votes: updated?.votes ?? 0 });
            } else {
                await supabase.from('idea_votes').insert({ idea_id: id, userid });
                await supabase.rpc('increment_idea_votes', { idea_id: id });
                const { data: updated } = await supabase.from('feature_ideas').select('votes').eq('id', id).single();
                return res.status(200).json({ success: true, voted: true, votes: updated?.votes ?? 0 });
            }
        }

        if (action === 'add') {
            const { title, body, requested_by_userid, requested_by_name, category } = req.body;
            if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required.' });
            if (!body?.trim()) return res.status(400).json({ success: false, message: 'Description is required.' });
            if (!requested_by_userid) return res.status(400).json({ success: false, message: 'User ID is required.' });
            const allowedCats = ['general','ui_ux','api','reporting','performance','security','other'];
            const safeCat = allowedCats.includes(category) ? category : 'general';
            const { data, error } = await supabase
                .from('feature_ideas')
                .insert({ title: title.trim(), body: body.trim(), requested_by_userid, requested_by_name, category: safeCat })
                .select().single();
            if (error) throw error;
            return res.status(200).json({ success: true, idea: { ...data, voted_by_me: false } });
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

        // ── DEV ACTIVITY — update (super_admin only) ─────────────────────────
        if (action === 'dev_activity_update') {
            const { userid, id, title, body, tag } = req.body;
            if (!(await isSuperAdmin(supabase, userid))) return res.status(403).json({ success: false, message: 'Access denied.' });
            if (!id) return res.status(400).json({ success: false, message: 'ID is required.' });
            if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required.' });
            if (!body?.trim())  return res.status(400).json({ success: false, message: 'Details are required.' });
            const allowed = ['completed', 'in_progress', 'planned', 'fix', 'update'];
            const safeTag = allowed.includes(tag) ? tag : 'update';
            const { data, error } = await supabase
                .from('dev_activities')
                .update({ title: title.trim(), body: body.trim(), tag: safeTag })
                .eq('id', id)
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

        // ── IDEA COMMENTS — list ──────────────────────────────────────────────
        if (action === 'list_comments') {
            const { idea_id } = req.body;
            if (!idea_id) return res.status(400).json({ success: false, message: 'idea_id is required.' });
            const { data, error } = await supabase
                .from('idea_comments')
                .select('*')
                .eq('idea_id', idea_id)
                .order('created_at', { ascending: true });
            if (error) throw error;
            return res.status(200).json({ success: true, comments: data || [] });
        }

        // ── IDEA COMMENTS — add ───────────────────────────────────────────────
        if (action === 'add_comment') {
            const { idea_id, body, posted_by_userid, posted_by_name } = req.body;
            if (!idea_id) return res.status(400).json({ success: false, message: 'idea_id is required.' });
            if (!body?.trim()) return res.status(400).json({ success: false, message: 'Comment cannot be empty.' });
            if (!posted_by_userid) return res.status(400).json({ success: false, message: 'User ID is required.' });
            const { data, error } = await supabase
                .from('idea_comments')
                .insert({ idea_id, body: body.trim(), posted_by_userid, posted_by_name: posted_by_name || 'Staff' })
                .select().single();
            if (error) throw error;
            return res.status(200).json({ success: true, comment: data });
        }

        // ── IDEA COMMENTS — delete ────────────────────────────────────────────
        if (action === 'delete_comment') {
            const { id, userid } = req.body;
            if (!id) return res.status(400).json({ success: false, message: 'ID is required.' });
            // Allow own comment deletion or admin
            const { data: comment } = await supabase.from('idea_comments').select('posted_by_userid').eq('id', id).single();
            const isOwn = comment?.posted_by_userid === userid;
            const isAdm = await isSuperAdmin(supabase, userid);
            if (!isOwn && !isAdm) return res.status(403).json({ success: false, message: 'Access denied.' });
            const { error } = await supabase.from('idea_comments').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (err) {
        console.error('Ideas API Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
