import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Partner-accessible actions — validated via partner_token in body, not staff session.
// Groups can mix staff + partners, so partners get the full group action set too.
// (setStatus/setThought stay staff-only — those live on app_users.)
const PARTNER_ACTIONS = new Set([
    'getUserList', 'getHistory', 'sendMessage', 'getUnreadCount',
    'getGroups', 'getGroupHistory', 'sendGroupMessage', 'getGroupMembers',
    'createGroup', 'addGroupMembers', 'renameGroup', 'leaveGroup'
]);

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
                .select('userid, first_name, last_name, last_seen, role, chat_status, chat_thought, chat_thought_at')
                .eq('is_active', true)
                .order('first_name');
            var THOUGHT_TTL = 24 * 60 * 60 * 1000;   // thoughts fade after 24h
            var freshThought = function (u) { return (u.chat_thought && u.chat_thought_at && (Date.now() - new Date(u.chat_thought_at).getTime()) < THOUGHT_TTL) ? u.chat_thought : null; };

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
                status: u.chat_status || 'available',
                thought: freshThought(u),
                unread: counts[u.userid] || 0,
                last_message: lastMsgMap[u.userid]
            }));

            // The caller's own status/thought (for the launcher UI)
            let me = null;
            if (!isPartner) {
                const self = (users || []).find(u => u.userid === sender_id);
                if (self) me = { status: self.chat_status || 'available', thought: freshThought(self) };
            }

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

            return res.status(200).json({ success: true, data: allUsers, unreadCounts: counts, me });
        }

        // ── SET STATUS (available / away / busy) ──────────
        if (action === 'setStatus') {
            const { status } = req.body;
            const allowed = ['available', 'away', 'busy'];
            if (!allowed.includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
            await supabase.from('app_users').update({ chat_status: status }).eq('userid', sender_id);
            return res.status(200).json({ success: true, status });
        }

        // ── DROP A THOUGHT ────────────────────────────────
        if (action === 'setThought') {
            let { thought } = req.body;
            thought = (thought || '').trim().slice(0, 120);
            await supabase.from('app_users').update({
                chat_thought: thought || null,
                chat_thought_at: thought ? new Date().toISOString() : null
            }).eq('userid', sender_id);
            return res.status(200).json({ success: true, thought: thought || null });
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

        // ══════════════ GROUP CHAT (additive) ══════════════
        // Resolve display names for a set of members (split by type to avoid
        // casting non-uuid staff ids against persons.id).
        async function namesForMembers(members) {
            const staffIds = members.filter(m => m.member_type !== 'partner').map(m => m.member_id);
            const partnerIds = members.filter(m => m.member_type === 'partner').map(m => m.member_id);
            const map = {};
            if (staffIds.length) {
                const { data } = await supabase.from('app_users').select('userid, first_name, last_name').in('userid', staffIds);
                (data || []).forEach(u => { map[u.userid] = `${u.first_name} ${u.last_name || ''}`.trim(); });
            }
            if (partnerIds.length) {
                const { data } = await supabase.from('persons').select('id, full_name').in('id', partnerIds);
                (data || []).forEach(p => { map[p.id] = p.full_name; });
            }
            return map;
        }
        async function myGroupMembership(groupId) {
            const { data } = await supabase.from('chat_group_members')
                .select('member_id, last_read_at').eq('group_id', groupId).eq('member_id', sender_id).maybeSingle();
            return data || null;
        }

        // ── CREATE GROUP ──────────────────────────────────
        if (action === 'createGroup') {
            const { name, members } = req.body;   // members: [{ id, type }]
            if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Group name required.' });
            const others = (Array.isArray(members) ? members : []).filter(m => m && m.id && String(m.id) !== String(sender_id));
            if (!others.length) return res.status(400).json({ success: false, message: 'Pick at least one other member.' });

            const { data: grp, error } = await supabase.from('chat_groups')
                .insert({ name: name.trim(), created_by: sender_id }).select('id, name, created_at').single();
            if (error) throw error;

            const rows = [{ group_id: grp.id, member_id: String(sender_id), member_type: 'staff' }];
            const seen = new Set([String(sender_id)]);
            others.forEach(m => { if (!seen.has(String(m.id))) { seen.add(String(m.id)); rows.push({ group_id: grp.id, member_id: String(m.id), member_type: m.type === 'partner' ? 'partner' : 'staff' }); } });
            await supabase.from('chat_group_members').insert(rows);

            return res.status(200).json({ success: true, group: { id: grp.id, name: grp.name, member_count: rows.length } });
        }

        // ── LIST MY GROUPS ────────────────────────────────
        if (action === 'getGroups') {
            const { data: mine } = await supabase.from('chat_group_members')
                .select('group_id, last_read_at').eq('member_id', sender_id);
            const groupIds = (mine || []).map(m => m.group_id);
            if (!groupIds.length) return res.status(200).json({ success: true, data: [] });
            const readMap = {};
            (mine || []).forEach(m => { readMap[m.group_id] = m.last_read_at; });

            const { data: groups } = await supabase.from('chat_groups').select('id, name').in('id', groupIds);
            const { data: counts } = await supabase.from('chat_group_members').select('group_id, member_id').in('group_id', groupIds);
            const memberCount = {};
            (counts || []).forEach(c => { memberCount[c.group_id] = (memberCount[c.group_id] || 0) + 1; });

            const out = [];
            for (const g of (groups || [])) {
                const { data: last } = await supabase.from('messages')
                    .select('content, created_at, sender_id').eq('group_id', g.id).is('deleted_at', null)
                    .order('created_at', { ascending: false }).limit(1).maybeSingle();
                const since = readMap[g.id] || '1970-01-01';
                const { count: unread } = await supabase.from('messages')
                    .select('*', { count: 'exact', head: true })
                    .eq('group_id', g.id).is('deleted_at', null)
                    .gt('created_at', since).neq('sender_id', String(sender_id));
                out.push({
                    id: g.id, name: g.name, is_group: true,
                    member_count: memberCount[g.id] || 1,
                    unread: unread || 0,
                    last_message: last ? { preview: last.content, time: last.created_at } : null
                });
            }
            out.sort((a, b) => {
                if (b.unread !== a.unread) return b.unread - a.unread;
                const at = a.last_message?.time ? new Date(a.last_message.time).getTime() : 0;
                const bt = b.last_message?.time ? new Date(b.last_message.time).getTime() : 0;
                return bt - at;
            });
            return res.status(200).json({ success: true, data: out });
        }

        // ── GROUP MEMBERS ─────────────────────────────────
        if (action === 'getGroupMembers') {
            const { group_id } = req.body;
            if (!await myGroupMembership(group_id)) return res.status(403).json({ success: false, message: 'Not a member.' });
            const { data: members } = await supabase.from('chat_group_members').select('member_id, member_type').eq('group_id', group_id);
            const nameMap = await namesForMembers(members || []);
            return res.status(200).json({ success: true, data: (members || []).map(m => ({ id: m.member_id, type: m.member_type, name: nameMap[m.member_id] || 'Unknown' })) });
        }

        // ── GROUP HISTORY ─────────────────────────────────
        if (action === 'getGroupHistory') {
            const { group_id, page = 0, limit = 50 } = req.body;
            if (!await myGroupMembership(group_id)) return res.status(403).json({ success: false, message: 'Not a member.' });

            const { data: members } = await supabase.from('chat_group_members').select('member_id, member_type').eq('group_id', group_id);
            const nameMap = await namesForMembers(members || []);

            const { data } = await supabase.from('messages').select('*')
                .eq('group_id', group_id).is('deleted_at', null)
                .order('created_at', { ascending: false }).range(page * limit, (page + 1) * limit - 1);

            // Mark this group read for me
            await supabase.from('chat_group_members').update({ last_read_at: new Date().toISOString() })
                .eq('group_id', group_id).eq('member_id', sender_id);

            const msgs = (data || []).reverse().map(m => Object.assign({}, m, { sender_name: nameMap[m.sender_id] || 'Unknown' }));
            return res.status(200).json({ success: true, data: msgs });
        }

        // ── SEND GROUP MESSAGE ────────────────────────────
        if (action === 'sendGroupMessage') {
            const { group_id, content } = req.body;
            if (!content?.trim() || !group_id) return res.status(400).json({ success: false, message: 'Content and group required.' });
            if (!await myGroupMembership(group_id)) return res.status(403).json({ success: false, message: 'Not a member.' });
            const { data, error } = await supabase.from('messages')
                .insert({ sender_id: String(sender_id), group_id, content: content.trim(), is_read: false, message_type: 'group' })
                .select().single();
            if (error) throw error;
            // Keep sender's own read pointer current so it doesn't count as unread.
            await supabase.from('chat_group_members').update({ last_read_at: new Date().toISOString() })
                .eq('group_id', group_id).eq('member_id', sender_id);
            return res.status(200).json({ success: true, data });
        }

        // ── RENAME GROUP ──────────────────────────────────
        if (action === 'renameGroup') {
            const { group_id, name } = req.body;
            if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name required.' });
            if (!await myGroupMembership(group_id)) return res.status(403).json({ success: false, message: 'Not a member.' });
            await supabase.from('chat_groups').update({ name: name.trim() }).eq('id', group_id);
            return res.status(200).json({ success: true, name: name.trim() });
        }

        // ── ADD MEMBERS ───────────────────────────────────
        if (action === 'addGroupMembers') {
            const { group_id, members } = req.body;
            if (!await myGroupMembership(group_id)) return res.status(403).json({ success: false, message: 'Not a member.' });
            const rows = (Array.isArray(members) ? members : []).filter(m => m && m.id)
                .map(m => ({ group_id, member_id: String(m.id), member_type: m.type === 'partner' ? 'partner' : 'staff' }));
            if (rows.length) await supabase.from('chat_group_members').upsert(rows, { onConflict: 'group_id,member_id', ignoreDuplicates: true });
            return res.status(200).json({ success: true, added: rows.length });
        }

        // ── LEAVE GROUP ───────────────────────────────────
        if (action === 'leaveGroup') {
            const { group_id } = req.body;
            await supabase.from('chat_group_members').delete().eq('group_id', group_id).eq('member_id', sender_id);
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('Chat API Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
