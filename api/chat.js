import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Partner-accessible actions — validated via partner_token in body, not staff session
const PARTNER_ACTIONS = new Set(['getUserList', 'getHistory', 'sendMessage', 'getUnreadCount']);

async function validatePartner(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions')
        .select('person_id, expires_at').eq('session_token', token).single();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, sender_id, partner_token } = req.body;

    // Determine if this is a partner request
    let isPartner = false;
    if (PARTNER_ACTIONS.has(action) && partner_token) {
        const personId = await validatePartner(partner_token);
        if (!personId) return res.status(401).json({ success: false, message: 'Invalid or expired partner session.', reason: 'invalid_token' });
        isPartner = true;
    } else {
        const session = await validateSession(req);
        if (!session) return sessionErrorResponse(res);
    }

    try {
        // Heartbeat — update last_seen (staff) or last_portal_login (partner)
        if (sender_id && action !== 'logout') {
            if (isPartner) {
                supabase.from('persons').update({ last_portal_login: new Date().toISOString() }).eq('id', sender_id);
            } else {
                await supabase.from('app_users').update({ last_seen: new Date().toISOString() }).eq('userid', sender_id);
            }
        }

        // ── LOGOUT ────────────────────────────────────────
        if (action === 'logout') {
            await supabase.from('app_users').update({ last_seen: null }).eq('userid', sender_id);
            return res.status(200).json({ success: true });
        }

        // ── GET USER LIST ─────────────────────────────────
        if (action === 'getUserList') {
            const { data: users } = await supabase
                .from('app_users')
                .select('userid, first_name, last_name, last_seen, role')
                .eq('is_active', true)
                .order('first_name');

            // Get partner users too (from persons with portal access)
            const { data: partners } = await supabase
                .from('persons')
                .select('id, full_name, last_portal_login, is_portal_active')
                .eq('is_portal_active', true)
                .order('full_name');

            // Unread counts
            const { data: unreadData } = await supabase
                .from('messages')
                .select('sender_id')
                .eq('recipient_id', sender_id)
                .eq('is_read', false);

            const counts = {};
            (unreadData||[]).forEach(m => { counts[m.sender_id] = (counts[m.sender_id]||0)+1; });

            // Last message per conversation
            const { data: lastMsgs } = await supabase
                .from('messages')
                .select('sender_id, recipient_id, content, created_at')
                .or(`sender_id.eq.${sender_id},recipient_id.eq.${sender_id}`)
                .order('created_at', { ascending: false })
                .limit(200);

            const lastMsgMap = {};
            (lastMsgs||[]).forEach(m => {
                const otherId = m.sender_id === sender_id ? m.recipient_id : m.sender_id;
                if (!lastMsgMap[otherId]) lastMsgMap[otherId] = { preview: m.content, time: m.created_at };
            });

            const staffUsers = (users||[]).filter(u => u.userid !== sender_id).map(u => ({
                id: u.userid,
                name: `${u.first_name} ${u.last_name||''}`.trim(),
                role: u.role,
                user_type: 'staff',
                is_online: u.last_seen && (Date.now() - new Date(u.last_seen).getTime()) < 90000,
                unread: counts[u.userid] || 0,
                last_message: lastMsgMap[u.userid]
            }));

            const partnerUsers = (partners||[]).map(p => ({
                id: p.id,
                name: p.full_name,
                role: 'Partner',
                user_type: 'partner',
                is_online: p.last_portal_login && (Date.now() - new Date(p.last_portal_login).getTime()) < 300000,
                unread: counts[p.id] || 0,
                last_message: lastMsgMap[p.id]
            }));

            // Sort by unread first, then last message time
            const allUsers = [...staffUsers, ...partnerUsers].sort((a, b) => {
                if (b.unread !== a.unread) return b.unread - a.unread;
                const at = a.last_message?.time ? new Date(a.last_message.time).getTime() : 0;
                const bt = b.last_message?.time ? new Date(b.last_message.time).getTime() : 0;
                return bt - at;
            });

            return res.status(200).json({ success: true, data: allUsers, unreadCounts: counts });
        }

        // ── GET HISTORY ───────────────────────────────────
        if (action === 'getHistory') {
            const { recipient_id, page = 0, limit = 50 } = req.body;

            // Mark as read
            await supabase.from('messages')
                .update({ is_read: true })
                .eq('sender_id', recipient_id)
                .eq('recipient_id', sender_id)
                .eq('is_read', false);

            const { data } = await supabase.from('messages')
                .select('*')
                .or(`and(sender_id.eq.${sender_id},recipient_id.eq.${recipient_id}),and(sender_id.eq.${recipient_id},recipient_id.eq.${sender_id})`)
                .is('deleted_at', null)
                .order('created_at', { ascending: false })
                .range(page * limit, (page + 1) * limit - 1);

            return res.status(200).json({ success: true, data: (data||[]).reverse() });
        }

        // ── SEND MESSAGE ──────────────────────────────────
        if (action === 'sendMessage') {
            const { recipient_id, content, message_type = 'dm' } = req.body;
            if (!content?.trim() || !recipient_id) return res.status(400).json({ success: false, message: 'Content and recipient required.' });

            const { data, error } = await supabase.from('messages').insert({
                sender_id,
                recipient_id,
                content: content.trim(),
                is_read: false,
                message_type
            }).select().single();

            if (error) throw error;

            // Get sender name for notification
            let senderName;
            if (isPartner) {
                const { data: person } = await supabase.from('persons').select('full_name').eq('id', sender_id).single();
                senderName = person?.full_name || 'Partner';
            } else {
                const { data: staffUser } = await supabase.from('app_users').select('first_name, last_name').eq('userid', sender_id).single();
                senderName = staffUser ? `${staffUser.first_name} ${staffUser.last_name||''}`.trim() : 'Staff';
            }

            // Create notification for recipient
            try {
                await supabase.from('notifications').insert({
                    recipient_id,
                    recipient_type: 'partner',
                    type: 'dm',
                    title: `New message from ${senderName}`,
                    body: content.trim().slice(0, 80),
                    actor_id: sender_id,
                    actor_name: senderName,
                    reference_id: sender_id,
                    link: '/partner/messages'
                });
            } catch(e) { /* notifications are optional */ }

            return res.status(200).json({ success: true, data });
        }

        // ── EDIT MESSAGE ──────────────────────────────────
        if (action === 'editMessage') {
            const { message_id, content } = req.body;
            const { data: msg } = await supabase.from('messages').select('sender_id').eq('id', message_id).single();
            if (!msg || msg.sender_id !== sender_id) return res.status(403).json({ success: false, message: 'Cannot edit others messages.' });
            await supabase.from('messages').update({ content: content.trim(), edited_at: new Date().toISOString() }).eq('id', message_id);
            return res.status(200).json({ success: true });
        }

        // ── DELETE MESSAGE ────────────────────────────────
        if (action === 'deleteMessage') {
            const { message_id } = req.body;
            const { data: msg } = await supabase.from('messages').select('sender_id').eq('id', message_id).single();
            if (!msg || msg.sender_id !== sender_id) return res.status(403).json({ success: false, message: 'Cannot delete others messages.' });
            await supabase.from('messages').update({ deleted_at: new Date().toISOString(), content: 'This message was deleted.' }).eq('id', message_id);
            return res.status(200).json({ success: true });
        }

        // ── GET UNREAD COUNT ──────────────────────────────
        if (action === 'getUnreadCount') {
            const { count } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('recipient_id', sender_id).eq('is_read', false);
            return res.status(200).json({ success: true, count: count || 0 });
        }

        // ── SEARCH MESSAGES ───────────────────────────────
        if (action === 'searchMessages') {
            const { query } = req.body;
            const { data } = await supabase.from('messages')
                .select('*')
                .or(`sender_id.eq.${sender_id},recipient_id.eq.${sender_id}`)
                .ilike('content', `%${query}%`)
                .order('created_at', { ascending: false })
                .limit(20);
            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('Chat API Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
