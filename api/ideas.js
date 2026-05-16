import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

async function isSuperAdmin(supabase, userid) {
    if (!userid) return false;
    const { data } = await supabase.from('app_users').select('role, is_active').eq('userid', userid).single();
    return data?.is_active === true && data?.role === 'super_admin';
}

async function isAdminOrDev(supabase, userid) {
    if (!userid) return false;
    const { data } = await supabase.from('app_users').select('role, is_active').eq('userid', userid).single();
    return data?.is_active === true && ['super_admin', 'developer'].includes(data?.role);
}

// Send in-app notification and trigger realtime pulse
async function sendNotification(supabase, { recipientId, type, title, body, actorId, actorName, ideaId }) {
    try {
        await supabase.from('notifications').insert({
            recipient_id: recipientId,
            recipient_type: 'staff',
            type,
            title,
            body,
            actor_id: actorId || '',
            actor_name: actorName || '',
            reference_id: ideaId,
            link: '/ideas-dashboard.html',
            is_read: false
        });
        // Trigger realtime badge refresh for all subscribers
        await supabase.from('notification_pulse').update({ updated_at: new Date().toISOString() }).gt('id', 0);
    } catch (e) {
        console.error('[Ideas Notification Error]', e.message);
    }
}

// Send email via Postmark
async function sendEmail(to, subject, htmlBody, textBody) {
    if (!process.env.POSTMARK_SERVER_TOKEN || !to) return;
    try {
        const { ServerClient } = await import('postmark');
        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
        await client.sendEmail({
            From: process.env.EMAIL_FROM,
            To: to,
            Subject: subject,
            HtmlBody: htmlBody,
            TextBody: textBody,
            MessageStream: 'outbound'
        });
    } catch (e) {
        console.error('[Ideas Email Error]', e.message);
    }
}

function ideaEmailWrapper(content) {
    return `<div style="font-family:'Inter',Arial,sans-serif;max-width:540px;margin:auto;padding:32px;border:1px solid #e2e8f0;border-radius:16px;color:#1e293b;background:#ffffff;">
        <div style="text-align:center;margin-bottom:24px;">
            <h2 style="color:#004990;margin:0;font-size:22px;">PayProTec</h2>
            <p style="color:#64748b;font-size:12px;margin:4px 0 0;">Ideas & Feature Requests</p>
        </div>
        ${content}
        <hr style="border:0;border-top:1px solid #f1f5f9;margin:28px 0;">
        <p style="font-size:11px;color:#94a3b8;text-align:center;">This is an automated notification from PayProTec Operations.</p>
    </div>`;
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

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

            // Email all super admins about the new request
            try {
                const { data: admins } = await supabase
                    .from('app_users').select('email, first_name').eq('role', 'super_admin').eq('is_active', true);
                for (const admin of admins || []) {
                    if (!admin.email) continue;
                    await sendEmail(
                        admin.email,
                        `💡 New Feature Request: "${title.trim()}"`,
                        ideaEmailWrapper(`
                            <h3 style="color:#0d9488;margin:0 0 8px;">New Feature Request</h3>
                            <p style="margin:0 0 16px;line-height:1.6;">A new idea has been submitted by <strong>${requested_by_name}</strong>.</p>
                            <div style="background:#f8fafc;border-radius:10px;padding:16px;margin-bottom:20px;">
                                <p style="font-weight:700;margin:0 0 6px;color:#1e293b;">${escapeHtml(title.trim())}</p>
                                <p style="color:#475569;margin:0;font-size:13px;line-height:1.6;">${escapeHtml(body.trim().slice(0, 300))}${body.length > 300 ? '…' : ''}</p>
                            </div>
                            <div style="text-align:center;">
                                <a href="https://${req.headers.host}/ideas-dashboard.html" style="background:#004990;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">Review Request</a>
                            </div>`),
                        `New feature request from ${requested_by_name}: "${title.trim()}". Visit the Ideas dashboard to review.`
                    );
                }
            } catch (e) {
                console.error('[Ideas add email error]', e.message);
            }

            return res.status(200).json({ success: true, idea: { ...data, voted_by_me: false } });
        }

        if (action === 'update_status') {
            const { id, status, actor_userid, actor_name } = req.body;
            const allowed = ['pending', 'in_progress', 'done', 'rejected'];
            if (!id) return res.status(400).json({ success: false, message: 'ID is required.' });
            if (!allowed.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });

            // Fetch the idea before updating (to get creator info)
            const { data: idea } = await supabase
                .from('feature_ideas').select('title, requested_by_userid, requested_by_name').eq('id', id).single();

            const { error } = await supabase
                .from('feature_ideas')
                .update({ status, updated_at: new Date().toISOString() })
                .eq('id', id);
            if (error) throw error;

            // Notify creator on all meaningful status changes (only if someone else made the change)
            const notifyStatuses = ['done', 'rejected', 'in_progress'];
            if (idea && notifyStatuses.includes(status) && idea.requested_by_userid && idea.requested_by_userid !== actor_userid) {
                const statusMeta = {
                    done:        { label: 'implemented ✅', notifTitle: 'Your idea was implemented!',    color: '#0d9488', heading: 'Great news!',    emoji: '✅' },
                    rejected:    { label: 'declined ❌',    notifTitle: 'Your idea was declined',         color: '#dc2626', heading: 'Status Update', emoji: '❌' },
                    in_progress: { label: 'in progress 🔧', notifTitle: 'Your idea is being worked on!', color: '#d97706', heading: 'In Progress!',   emoji: '🔧' }
                };
                const meta = statusMeta[status];

                // In-app notification
                await sendNotification(supabase, {
                    recipientId: idea.requested_by_userid,
                    type: 'idea_status',
                    title: meta.notifTitle,
                    body: idea.title.slice(0, 100),
                    actorId: actor_userid || '',
                    actorName: actor_name || 'Admin',
                    ideaId: id
                });

                // Email the creator
                const { data: creator } = await supabase
                    .from('app_users').select('email, first_name').eq('userid', idea.requested_by_userid).single();
                if (creator?.email) {
                    await sendEmail(
                        creator.email,
                        `${meta.emoji} ${meta.notifTitle}: "${idea.title}"`,
                        ideaEmailWrapper(`
                            <h3 style="color:${meta.color};margin:0 0 8px;">${meta.heading}</h3>
                            <p style="margin:0 0 16px;line-height:1.6;">Hi <strong>${creator.first_name || 'there'}</strong>, your feature request has been marked as <strong>${meta.label}</strong>.</p>
                            <div style="background:#f8fafc;border-radius:10px;padding:16px;margin-bottom:20px;">
                                <p style="font-weight:700;margin:0;color:#1e293b;">${escapeHtml(idea.title)}</p>
                            </div>
                            <div style="text-align:center;">
                                <a href="https://${req.headers.host}/ideas-dashboard.html" style="background:#004990;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">View Ideas Board</a>
                            </div>`),
                        `Hi ${creator.first_name || 'there'}, your idea "${idea.title}" has been ${meta.label}.`
                    );
                }
            }

            return res.status(200).json({ success: true });
        }

        if (action === 'delete') {
            const { id } = req.body;
            if (!id) return res.status(400).json({ success: false, message: 'ID is required.' });
            const { error } = await supabase.from('feature_ideas').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // ── LIST STAFF (for @mention autocomplete) ────────────────────────────
        if (action === 'list_staff') {
            const { data } = await supabase
                .from('app_users')
                .select('userid, first_name, last_name')
                .eq('is_active', true)
                .order('first_name');
            const staff = (data || []).map(u => ({
                userid: u.userid,
                name: [u.first_name, u.last_name].filter(Boolean).join(' ')
            }));
            return res.status(200).json({ success: true, staff });
        }

        // ── GET MY NOTIFICATIONS ──────────────────────────────────────────────
        if (action === 'get_my_notifications') {
            const { userid } = req.body;
            if (!userid) return res.status(400).json({ success: false, message: 'userid required.' });
            const { data } = await supabase
                .from('notifications')
                .select('id, type, title, body, actor_name, is_read, created_at, reference_id, link')
                .eq('recipient_id', userid)
                .in('type', ['idea_status', 'idea_mention'])
                .order('created_at', { ascending: false })
                .limit(20);
            const unread = (data || []).filter(n => !n.is_read).length;
            return res.status(200).json({ success: true, notifications: data || [], unread });
        }

        // ── MARK NOTIFICATION READ ────────────────────────────────────────────
        if (action === 'mark_notifications_read') {
            const { userid, notif_id } = req.body;
            if (!userid) return res.status(400).json({ success: false });
            let q = supabase.from('notifications')
                .update({ is_read: true })
                .eq('recipient_id', userid);
            if (notif_id) {
                q = q.eq('id', notif_id);
            } else {
                q = q.in('type', ['idea_status', 'idea_mention']);
            }
            await q;
            return res.status(200).json({ success: true });
        }

        // ── DEV ACTIVITY — list ──────────────────────────────────────────────
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
            const { idea_id, body, posted_by_userid, posted_by_name, mentions } = req.body;
            if (!idea_id) return res.status(400).json({ success: false, message: 'idea_id is required.' });
            if (!body?.trim()) return res.status(400).json({ success: false, message: 'Comment cannot be empty.' });
            if (!posted_by_userid) return res.status(400).json({ success: false, message: 'User ID is required.' });
            const { data, error } = await supabase
                .from('idea_comments')
                .insert({ idea_id, body: body.trim(), posted_by_userid, posted_by_name: posted_by_name || 'Staff' })
                .select().single();
            if (error) throw error;

            // Fetch idea title for context in emails
            const { data: idea } = await supabase
                .from('feature_ideas').select('title').eq('id', idea_id).single();
            const ideaTitle = idea?.title || 'a feature request';

            // Send in-app notification + email to each @mentioned user
            const safeMentions = Array.isArray(mentions) ? mentions.slice(0, 10) : [];
            for (const m of safeMentions) {
                if (!m.userid || m.userid === posted_by_userid) continue;
                await sendNotification(supabase, {
                    recipientId: m.userid,
                    type: 'idea_mention',
                    title: `${posted_by_name} mentioned you in a comment`,
                    body: body.trim().slice(0, 100),
                    actorId: posted_by_userid,
                    actorName: posted_by_name,
                    ideaId: idea_id
                });
                // Email the mentioned user
                const { data: mentionedUser } = await supabase
                    .from('app_users').select('email, first_name').eq('userid', m.userid).single();
                if (mentionedUser?.email) {
                    await sendEmail(
                        mentionedUser.email,
                        `💬 ${posted_by_name} mentioned you in a comment`,
                        ideaEmailWrapper(`
                            <h3 style="color:#004990;margin:0 0 8px;">You were mentioned</h3>
                            <p style="margin:0 0 16px;line-height:1.6;">Hi <strong>${mentionedUser.first_name || 'there'}</strong>, <strong>${escapeHtml(posted_by_name)}</strong> mentioned you in a comment on:</p>
                            <div style="background:#f8fafc;border-radius:10px;padding:14px 16px;margin-bottom:16px;">
                                <p style="font-weight:700;margin:0 0 8px;color:#1e293b;">${escapeHtml(ideaTitle)}</p>
                                <p style="color:#475569;margin:0;font-size:13px;line-height:1.6;font-style:italic;">"${escapeHtml(body.trim().slice(0, 200))}${body.trim().length > 200 ? '…' : ''}"</p>
                            </div>
                            <div style="text-align:center;">
                                <a href="https://${req.headers.host}/ideas-dashboard.html" style="background:#004990;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block;">View Ideas Board</a>
                            </div>`),
                        `${posted_by_name} mentioned you in a comment on "${ideaTitle}": "${body.trim().slice(0, 150)}"`
                    );
                }
            }

            return res.status(200).json({ success: true, comment: data });
        }

        // ── IDEA COMMENTS — delete ────────────────────────────────────────────
        if (action === 'delete_comment') {
            const { id, userid } = req.body;
            if (!id) return res.status(400).json({ success: false, message: 'ID is required.' });
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

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
