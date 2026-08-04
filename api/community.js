import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import crypto from 'crypto';

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── AUTH HELPERS ───────────────────────────────────────────
async function resolveUser(req) {
    const { token, staff_userid } = req.body;
    
    // Staff auth via localStorage userid
    if (staff_userid) {
        const { data } = await supabase.from('app_users').select('userid, first_name, last_name, role').eq('userid', staff_userid).eq('is_active', true).single();
        if (data) return { id: data.userid, type: 'staff', name: `${data.first_name} ${data.last_name}`, role: data.role };
    }
    
    // Partner auth via session token
    if (token) {
        const { data: session } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).single();
        if (!session || new Date(session.expires_at) < new Date()) return null;
        const { data: person } = await supabase.from('persons').select('id, full_name').eq('id', session.person_id).single();
        if (person) return { id: person.id, type: 'partner', name: person.full_name, role: 'partner' };
    }
    
    return null;
}

async function getOrCreateProfile(user) {
    const { data: existing } = await supabase.from('user_profiles').select('*').eq('user_id', user.id).single();
    if (existing) return existing;
    
    const { data: created } = await supabase.from('user_profiles').insert({
        user_id: user.id,
        user_type: user.type,
        display_name: user.name,
    }).select().single();
    return created;
}

export default async function handler(req, res) {
    // Partners send their session as `token` in the body and are validated by resolveUser().
    // Staff requests carry no `token` and must pass the staff session header check.
    const { token } = req.body || {};
    if (!token) {
        const session = await validateSession(req);
        if (!session) return sessionErrorResponse(res);
    }

    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action } = req.body || {};
    if (!action) return res.status(400).json({ success: false, message: 'No action' });

    try {
        const user = await resolveUser(req);
        if (!user) return res.status(401).json({ success: false, message: 'Unauthorized' });

        // ── GET CHANNELS ──────────────────────────────────
        if (action === 'get_channels') {
            const { data } = await supabase.from('community_channels').select('*').eq('is_active', true).order('sort_order');
            
            // Get unread count per channel for this user
            const channelIds = (data || []).map(c => c.id);
            return res.status(200).json({ success: true, data: data || [] });
        }

        // ── GET FEED ──────────────────────────────────────
        if (action === 'get_feed') {
            const { channel_id, page = 0, limit = 20 } = req.body;
            
            let query = supabase.from('community_posts')
                .select(`id, body, image_url, is_pinned, is_announcement, cta_label, cta_url, created_at, author_id, author_type, channel_id,
                    community_channels(name, icon, color),
                    community_reactions(id, user_id, emoji),
                    community_comments(id)`, { count: 'exact' })
                .eq('is_deleted', false);

            if (channel_id) query = query.eq('channel_id', channel_id);

            const { data, count } = await query
                .order('is_announcement', { ascending: false })   // announcements first (important)
                .order('is_pinned', { ascending: false })
                .order('created_at', { ascending: false })
                .range(page * limit, (page + 1) * limit - 1);

            // Enrich with author profiles
            const authorIds = [...new Set((data || []).map(p => p.author_id))];
            const { data: profiles } = await supabase.from('user_profiles').select('user_id, display_name, avatar_url, user_type').in('user_id', authorIds);
            const profileMap = {};
            (profiles || []).forEach(p => profileMap[p.user_id] = p);

            const enriched = (data || []).map(post => ({
                ...post,
                author: profileMap[post.author_id] || { display_name: 'Unknown', avatar_url: null },
                reaction_count: post.community_reactions?.length || 0,
                comment_count: post.community_comments?.length || 0,
                user_reacted: (post.community_reactions || []).some(r => r.user_id === user.id),
                community_reactions: undefined,
                community_comments: undefined
            }));

            return res.status(200).json({ success: true, data: enriched, count: count || 0, has_more: ((page + 1) * limit) < (count || 0) });
        }

        // ── CREATE POST ───────────────────────────────────
        if (action === 'create_post') {
            const { body, channel_id, image_url, cta_label, cta_url } = req.body;
            // Facebook-style: a post can be text, photo, or both
            if (!body?.trim() && !image_url) return res.status(400).json({ success: false, message: 'Post needs text or a photo' });

            // Check announcement channel permissions
            let isAnnouncement = false;
            if (channel_id) {
                const { data: channel } = await supabase.from('community_channels').select('is_announcement').eq('id', channel_id).single();
                isAnnouncement = !!channel?.is_announcement;
                if (isAnnouncement && user.type !== 'staff') {
                    return res.status(403).json({ success: false, message: 'Only staff can post in Announcements.' });
                }
            }
            // CTA: staff-only, and a valid http(s)/relative link.
            let ctaLabel = null, ctaUrl = null;
            if (user.type === 'staff' && cta_url && String(cta_url).trim()) {
                const u = String(cta_url).trim();
                if (/^(https?:\/\/|\/)/i.test(u)) { ctaUrl = u.slice(0, 1000); ctaLabel = String(cta_label || 'Learn more').trim().slice(0, 60); }
            }

            await getOrCreateProfile(user);

            const { data: post, error } = await supabase.from('community_posts').insert({
                author_id: user.id,
                author_type: user.type,
                channel_id: channel_id || null,
                body: (body || '').trim(),
                image_url: image_url || null,
                is_announcement: isAnnouncement,
                cta_label: ctaLabel,
                cta_url: ctaUrl
            }).select().single();

            if (error) throw error;

            // Notify all other members about new post
            const { data: allProfiles } = await supabase
                .from('user_profiles').select('user_id, user_type').neq('user_id', user.id);
            if (allProfiles && allProfiles.length) {
                await supabase.from('notifications').insert(
                    allProfiles.map(p => ({
                        recipient_id: p.user_id,
                        recipient_type: p.user_type,
                        type: 'post',
                        title: `${user.name} posted something new`,
                        body: (body || '').trim().slice(0, 100) || '📷 Photo',
                        actor_id: user.id,
                        actor_name: user.name,
                        reference_id: post.id,
                        link: '/partner/community'
                    }))
                );
            }

            return res.status(200).json({ success: true, data: post });
        }

        // ── TRACK CTA CLICK (any signed-in member) ────────
        if (action === 'track_post_click') {
            const { post_id } = req.body;
            if (!post_id) return res.status(400).json({ success: false, message: 'post_id required' });
            // Only record for posts that actually have a CTA.
            const { data: post } = await supabase.from('community_posts').select('id, cta_url').eq('id', post_id).single();
            if (post?.cta_url) {
                await supabase.from('community_post_clicks').insert({ post_id, user_id: user.id, user_type: user.type });
            }
            return res.status(200).json({ success: true });
        }

        // ── ANNOUNCEMENT STATS (staff + marketing) ────────
        if (action === 'announcement_stats') {
            if (user.type !== 'staff') return res.status(403).json({ success: false, message: 'Staff only.' });
            const roleL = String(user.role || '').toLowerCase();
            let canMkt = roleL.includes('super') || roleL.includes('admin');
            if (!canMkt) {
                const { data: au } = await supabase.from('app_users').select('access_marketing, access_marketing_settings').eq('userid', user.id).maybeSingle();
                canMkt = !!(au?.access_marketing || au?.access_marketing_settings);
            }
            if (!canMkt) return res.status(403).json({ success: false, message: 'Marketing access required.' });

            // Announcement posts that carry a CTA.
            const { data: posts } = await supabase.from('community_posts')
                .select('id, body, image_url, cta_label, cta_url, created_at, author_id')
                .eq('is_announcement', true).eq('is_deleted', false).not('cta_url', 'is', null)
                .order('created_at', { ascending: false }).limit(200);
            const ids = (posts || []).map(p => p.id);
            const stats = {};
            ids.forEach(id => { stats[id] = { clickers: {}, likers: {}, commenters: {} }; });
            if (ids.length) {
                const [{ data: clicks }, { data: reactions }, { data: comments }] = await Promise.all([
                    supabase.from('community_post_clicks').select('post_id, user_id, user_type, clicked_at').in('post_id', ids).limit(50000),
                    supabase.from('community_reactions').select('post_id, user_id, emoji').in('post_id', ids).limit(50000),
                    supabase.from('community_comments').select('post_id, author_id, author_type, created_at').in('post_id', ids).eq('is_deleted', false).limit(50000)
                ]);
                (clicks || []).forEach(c => { const s = stats[c.post_id]; if (!s) return; const k = c.user_id; if (!s.clickers[k]) s.clickers[k] = { user_id: c.user_id, user_type: c.user_type, count: 0, last: null }; s.clickers[k].count++; if (!s.clickers[k].last || c.clicked_at > s.clickers[k].last) s.clickers[k].last = c.clicked_at; });
                (reactions || []).forEach(r => { const s = stats[r.post_id]; if (!s) return; const k = r.user_id; if (!s.likers[k]) s.likers[k] = { user_id: r.user_id, emojis: [] }; if (r.emoji && s.likers[k].emojis.indexOf(r.emoji) === -1) s.likers[k].emojis.push(r.emoji); });
                (comments || []).forEach(c => { const s = stats[c.post_id]; if (!s) return; const k = c.author_id; if (!s.commenters[k]) s.commenters[k] = { user_id: c.author_id, user_type: c.author_type, count: 0, last: null }; s.commenters[k].count++; if (!s.commenters[k].last || c.created_at > s.commenters[k].last) s.commenters[k].last = c.created_at; });
            }
            // Resolve every referenced user's name + type.
            const allUserIds = new Set();
            (posts || []).forEach(p => allUserIds.add(p.author_id));
            Object.values(stats).forEach(s => { [s.clickers, s.likers, s.commenters].forEach(m => Object.keys(m).forEach(k => allUserIds.add(k))); });
            const { data: profs } = allUserIds.size ? await supabase.from('user_profiles').select('user_id, display_name, user_type').in('user_id', [...allUserIds]) : { data: [] };
            const infoOf = {}; (profs || []).forEach(p => { infoOf[p.user_id] = { name: p.display_name, type: p.user_type }; });
            const nm = (id, fallbackType) => (infoOf[id]?.name) || (fallbackType === 'staff' ? 'Staff' : (fallbackType === 'partner' ? 'Partner' : 'Member'));
            const ty = (id, fallbackType) => (infoOf[id]?.type) || fallbackType || 'member';
            const out = (posts || []).map(p => {
                const s = stats[p.id];
                const clickers = Object.values(s.clickers).map(c => ({ name: nm(c.user_id, c.user_type), user_type: ty(c.user_id, c.user_type), count: c.count, last: c.last })).sort((a, b) => b.count - a.count);
                const likers = Object.values(s.likers).map(l => ({ name: nm(l.user_id), user_type: ty(l.user_id), emoji: l.emojis[0] || '❤️' }));
                const commenters = Object.values(s.commenters).map(c => ({ name: nm(c.user_id, c.user_type), user_type: ty(c.user_id, c.user_type), count: c.count, last: c.last })).sort((a, b) => b.count - a.count);
                return {
                    id: p.id, body: p.body, image_url: p.image_url, cta_label: p.cta_label, cta_url: p.cta_url,
                    created_at: p.created_at, author: nm(p.author_id, 'staff'),
                    clicks: clickers.reduce((n, c) => n + c.count, 0), unique_clickers: clickers.length,
                    likes: likers.length, comments: commenters.reduce((n, c) => n + c.count, 0),
                    clickers, likers, commenters
                };
            });
            return res.status(200).json({ success: true, data: out });
        }

        // ── TOGGLE PIN (staff only) ───────────────────────
        if (action === 'toggle_pin') {
            const { post_id } = req.body;
            if (user.type !== 'staff') return res.status(403).json({ success: false, message: 'Staff only.' });
            const { data: post } = await supabase.from('community_posts').select('is_pinned').eq('id', post_id).single();
            if (!post) return res.status(404).json({ success: false });
            await supabase.from('community_posts').update({ is_pinned: !post.is_pinned }).eq('id', post_id);
            return res.status(200).json({ success: true, pinned: !post.is_pinned });
        }

        // ── DELETE POST ───────────────────────────────────
        if (action === 'delete_post') {
            const { post_id } = req.body;
            const { data: post } = await supabase.from('community_posts').select('author_id').eq('id', post_id).single();
            if (!post) return res.status(404).json({ success: false });
            if (post.author_id !== user.id && user.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Cannot delete others posts.' });
            await supabase.from('community_posts').update({ is_deleted: true }).eq('id', post_id);
            return res.status(200).json({ success: true });
        }

        // ── REACT TO POST ─────────────────────────────────
        if (action === 'react') {
            const { post_id, emoji = '👍' } = req.body;
            const { data: existing } = await supabase.from('community_reactions').select('id').eq('post_id', post_id).eq('user_id', user.id).eq('emoji', emoji).single();
            
            if (existing) {
                await supabase.from('community_reactions').delete().eq('id', existing.id);
                return res.status(200).json({ success: true, action: 'removed' });
            } else {
                await supabase.from('community_reactions').insert({ post_id, user_id: user.id, emoji });
                return res.status(200).json({ success: true, action: 'added' });
            }
        }

        // ── GET COMMENTS ──────────────────────────────────
        if (action === 'get_comments') {
            const { post_id } = req.body;
            const { data } = await supabase.from('community_comments').select('*').eq('post_id', post_id).eq('is_deleted', false).order('created_at');
            
            const authorIds = [...new Set((data || []).map(c => c.author_id))];
            const { data: profiles } = await supabase.from('user_profiles').select('user_id, display_name, avatar_url, user_type').in('user_id', authorIds);
            const profileMap = {};
            (profiles || []).forEach(p => profileMap[p.user_id] = p);

            const enriched = (data || []).map(c => ({ ...c, author: profileMap[c.author_id] || { display_name: 'Unknown' } }));
            return res.status(200).json({ success: true, data: enriched });
        }

        // ── ADD COMMENT ───────────────────────────────────
        if (action === 'add_comment') {
            const { post_id, body } = req.body;
            if (!body?.trim()) return res.status(400).json({ success: false, message: 'Comment required' });
            await getOrCreateProfile(user);
            const { error } = await supabase.from('community_comments').insert({ post_id, author_id: user.id, author_type: user.type, body: body.trim() });
            if (error) throw error;
            // Notify post author
            const { data: post } = await supabase.from('community_posts').select('author_id, author_type').eq('id', post_id).single();
            if (post && post.author_id !== user.id) {
                await supabase.from('notifications').insert({
                    recipient_id: post.author_id, recipient_type: post.author_type,
                    type: 'comment', title: `${user.name} commented on your post`,
                    body: body.trim().slice(0, 80), actor_id: user.id, actor_name: user.name,
                    reference_id: post_id, link: '/partner/community'
                });
            }
            return res.status(200).json({ success: true });
        }

        // ── GET CHANNEL MESSAGES ──────────────────────────
        if (action === 'get_channel_messages') {
            const { channel_id, before } = req.body;
            let query = supabase.from('channel_messages').select('*').eq('channel_id', channel_id).eq('is_deleted', false).order('created_at', { ascending: false }).limit(50);
            if (before) query = query.lt('created_at', before);
            const { data } = await query;

            const authorIds = [...new Set((data || []).map(m => m.author_id))];
            const { data: profiles } = await supabase.from('user_profiles').select('user_id, display_name, avatar_url, user_type').in('user_id', authorIds);
            const profileMap = {};
            (profiles || []).forEach(p => profileMap[p.user_id] = p);

            return res.status(200).json({ success: true, data: (data || []).reverse().map(m => ({ ...m, author: profileMap[m.author_id] || { display_name: 'Unknown' } })) });
        }

        // ── SEND CHANNEL MESSAGE ──────────────────────────
        if (action === 'send_channel_message') {
            const { channel_id, body } = req.body;
            if (!body?.trim()) return res.status(400).json({ success: false, message: 'Message required' });
            
            const { data: channel } = await supabase.from('community_channels').select('is_announcement').eq('id', channel_id).single();
            if (channel?.is_announcement && user.type !== 'staff') return res.status(403).json({ success: false, message: 'Only staff can post in Announcements.' });
            
            await getOrCreateProfile(user);
            const { error: chMsgErr } = await supabase.from('channel_messages').insert({ channel_id, author_id: user.id, author_type: user.type, body: body.trim() });
            if (chMsgErr) throw chMsgErr;
            return res.status(200).json({ success: true });
        }

        // ── GET DM CONVERSATIONS ──────────────────────────
        if (action === 'get_conversations') {
            // Get all unique conversations for this user
            const { data: sent } = await supabase.from('direct_messages').select('recipient_id, recipient_type, created_at, body').eq('sender_id', user.id).order('created_at', { ascending: false });
            const { data: received } = await supabase.from('direct_messages').select('sender_id, sender_type, created_at, body, is_read').eq('recipient_id', user.id).order('created_at', { ascending: false });

            // Build conversation map
            const convMap = {};
            (sent || []).forEach(m => {
                const key = m.recipient_id;
                if (!convMap[key]) convMap[key] = { other_id: m.recipient_id, other_type: m.recipient_type, last_message: m.body, last_at: m.created_at, unread: 0 };
            });
            (received || []).forEach(m => {
                const key = m.sender_id;
                if (!convMap[key]) convMap[key] = { other_id: m.sender_id, other_type: m.sender_type, last_message: m.body, last_at: m.created_at, unread: 0 };
                if (!m.is_read) convMap[key].unread = (convMap[key].unread || 0) + 1;
                if (new Date(m.created_at) > new Date(convMap[key].last_at)) { convMap[key].last_message = m.body; convMap[key].last_at = m.created_at; }
            });

            const convs = Object.values(convMap).sort((a, b) => new Date(b.last_at) - new Date(a.last_at));

            // Enrich with profiles
            const otherIds = convs.map(c => c.other_id);
            const { data: profiles } = await supabase.from('user_profiles').select('user_id, display_name, avatar_url, user_type, is_online').in('user_id', otherIds);
            const profileMap = {};
            (profiles || []).forEach(p => profileMap[p.user_id] = p);

            const enriched = convs.map(c => ({ ...c, other_profile: profileMap[c.other_id] || { display_name: 'Unknown' } }));
            return res.status(200).json({ success: true, data: enriched });
        }

        // ── GET DM THREAD ─────────────────────────────────
        if (action === 'get_dm_thread') {
            const { other_id } = req.body;
            const { data } = await supabase.from('direct_messages')
                .select('*')
                .or(`and(sender_id.eq.${user.id},recipient_id.eq.${other_id}),and(sender_id.eq.${other_id},recipient_id.eq.${user.id})`)
                .order('created_at');

            // Mark as read
            await supabase.from('direct_messages').update({ is_read: true }).eq('recipient_id', user.id).eq('sender_id', other_id).eq('is_read', false);

            // Get other user's profile
            const { data: otherProfile } = await supabase.from('user_profiles').select('*').eq('user_id', other_id).single();

            return res.status(200).json({ success: true, data: data || [], other_profile: otherProfile });
        }

        // ── SEND DM ───────────────────────────────────────
        if (action === 'send_dm') {
            const { recipient_id, recipient_type, body } = req.body;
            if (!body?.trim() || !recipient_id) return res.status(400).json({ success: false, message: 'Message and recipient required.' });
            if (body.trim().length > 2000) return res.status(400).json({ success: false, message: 'Message too long (max 2000 characters).' });
            await getOrCreateProfile(user);
            const { data: dmMsg, error: dmErr } = await supabase.from('direct_messages')
                .insert({ sender_id: user.id, sender_type: user.type, recipient_id, recipient_type: recipient_type || 'partner', body: body.trim() })
                .select().single();
            if (dmErr) throw dmErr;
            // Notify recipient (fire-and-forget — DM already saved)
            supabase.from('notifications').insert({
                recipient_id, recipient_type: recipient_type || 'partner',
                type: 'dm', title: `New message from ${user.name}`,
                body: body.trim().slice(0, 80), actor_id: user.id, actor_name: user.name,
                reference_id: user.id, link: '/partner/messages'
            }).then(() => {});
            return res.status(200).json({ success: true, data: dmMsg });
        }

        // ── GET ALL USERS (for DM search) ─────────────────
        if (action === 'get_all_users') {
            const { search = '' } = req.body;
            const { data: profiles } = await supabase.from('user_profiles').select('user_id, display_name, avatar_url, user_type, is_online, tagline').ilike('display_name', `%${search}%`).limit(20);
            return res.status(200).json({ success: true, data: (profiles || []).filter(p => p.user_id !== user.id) });
        }

        // ── GET / UPDATE PROFILE ──────────────────────────
        if (action === 'get_profile') {
            const targetId = req.body.user_id || req.body.profile_user_id || user.id;
            let profile = await getOrCreateProfile({ id: targetId, type: user.type, name: user.name });
            const isSelf = targetId === user.id;
            const sm = isSelf ? {} : await peerStatusMap(user.id, [targetId]);
            const peer_status = isSelf ? 'self' : (sm[targetId] || 'none');
            const peer_count = await peerCount(targetId);
            const locked = !isSelf && profile.is_public === false && peer_status !== 'peers';

            // Partner portfolio stats (only when visible).
            let stats = null;
            if (!locked && profile.user_type === 'partner') {
                const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', targetId);
                if (agents?.length) {
                    const { data: identifiers } = await supabase.from('agent_identifiers').select('id_string').in('agent_id', agents.map(a => a.id));
                    const ids = (identifiers || []).map(i => i.id_string);
                    if (ids.length) {
                        const { data: statsData } = await supabase.from('merchant_stats_by_id').select('merchant_count, total_volume_sum, total_volume_90d_sum').in('agent_id', ids);
                        let merchants = 0, mtd = 0, vol90 = 0;
                        (statsData || []).forEach(s => { merchants += parseInt(s.merchant_count || 0); mtd += parseFloat(s.total_volume_sum || 0); vol90 += parseFloat(s.total_volume_90d_sum || 0); });
                        stats = { merchants, mtd, vol90 };
                    }
                }
            }
            if (locked) {
                profile = { user_id: profile.user_id, user_type: profile.user_type, display_name: profile.display_name, avatar_url: profile.avatar_url, company: profile.company, is_public: false, locked: true };
            }
            return res.status(200).json({ success: true, profile, data: profile, stats, peer_status, peer_count });
        }

        if (action === 'update_profile') {
            const { display_name, bio, tagline, phone, location, website, avatar_url, company, is_public } = req.body;
            const updates = {};
            if (display_name !== undefined) updates.display_name = display_name;
            if (bio !== undefined) updates.bio = bio;
            if (tagline !== undefined) updates.tagline = tagline;
            if (phone !== undefined) updates.phone = phone;
            if (location !== undefined) updates.location = location;
            if (website !== undefined) updates.website = website;
            if (avatar_url !== undefined) updates.avatar_url = avatar_url;
            if (company !== undefined) updates.company = company;
            if (is_public !== undefined) updates.is_public = !!is_public;

            const { error: upErr } = await supabase.from('user_profiles').upsert({ user_id: user.id, user_type: user.type, display_name: user.name, ...updates }, { onConflict: 'user_id' });
            if (upErr) return res.status(500).json({ success: false, message: upErr.message });
            return res.status(200).json({ success: true, avatar_url: updates.avatar_url });
        }

        // ── CHANGE PASSWORD (partner) ─────────────────────
        if (action === 'change_password') {
            const { current_password, new_password } = req.body;
            if (user.type !== 'partner') return res.status(403).json({ success: false, message: 'Staff password changes not supported here.' });
            if (!new_password || new_password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });

            const { data: person } = await supabase.from('persons').select('password_hash').eq('id', user.id).single();
            const currentHash = crypto.createHash('sha256').update(current_password + (process.env.PARTNER_SALT || 'pp_partner_2024')).digest('hex');
            if (currentHash !== person.password_hash) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });

            const newHash = crypto.createHash('sha256').update(new_password + (process.env.PARTNER_SALT || 'pp_partner_2024')).digest('hex');
            await supabase.from('persons').update({ password_hash: newHash }).eq('id', user.id);
            return res.status(200).json({ success: true });
        }

        // ── UPLOAD AVATAR ─────────────────────────────────
        if (action === 'get_avatar_upload_url') {
            const { file_type } = req.body;
            const ext = file_type === 'image/png' ? 'png' : file_type === 'image/webp' ? 'webp' : 'jpg';
            // upsert:true — signed upload URLs fail on existing objects otherwise,
            // which broke every avatar re-upload after the first one
            const path = `${user.id}/avatar.${ext}`;
            const { data, error } = await supabase.storage.from('avatars').createSignedUploadUrl(path, { upsert: true });
            if (error) throw error;
            const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/avatars/${path}`;
            return res.status(200).json({ success: true, upload_url: data.signedUrl, public_url: publicUrl });
        }

        // ── UPLOAD POST IMAGE (unique path per upload) ────
        if (action === 'get_post_image_upload_url') {
            const { file_type } = req.body;
            const ALLOWED = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
            const ext = ALLOWED[file_type];
            if (!ext) return res.status(400).json({ success: false, message: 'Only PNG, JPG, WEBP, or GIF images are allowed.' });
            const path = `posts/${user.id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
            const { data, error } = await supabase.storage.from('avatars').createSignedUploadUrl(path);
            if (error) throw error;
            const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/avatars/${path}`;
            return res.status(200).json({ success: true, upload_url: data.signedUrl, public_url: publicUrl });
        }

        // ── MARK ONLINE ───────────────────────────────────
        if (action === 'heartbeat') {
            await supabase.from('user_profiles').upsert({ user_id: user.id, user_type: user.type, display_name: user.name, is_online: true, last_seen: new Date().toISOString() }, { onConflict: 'user_id' });
            return res.status(200).json({ success: true });
        }


        // ── GET UNREAD COUNTS (badge polling) ─────────────
        if (action === 'get_unread_counts') {
            const [dmResult, notifResult] = await Promise.all([
                supabase.from('direct_messages')
                    .select('*', { count: 'exact', head: true })
                    .eq('recipient_id', user.id)
                    .eq('is_read', false),
                supabase.from('notifications')
                    .select('*', { count: 'exact', head: true })
                    .eq('recipient_id', user.id)
                    .eq('is_read', false)
            ]);
            return res.status(200).json({ 
                success: true, 
                dms: dmResult.count || 0, 
                notifications: notifResult.count || 0 
            });
        }

        // ── GET NOTIFICATIONS ─────────────────────────────
        if (action === 'get_notifications') {
            const { data } = await supabase.from('notifications')
                .select('*')
                .eq('recipient_id', user.id)
                .order('created_at', { ascending: false })
                .limit(30);
            return res.status(200).json({ success: true, data: data || [] });
        }

        // ── MARK NOTIFICATIONS READ ───────────────────────
        if (action === 'mark_notifications_read') {
            const { ids } = req.body;
            let q = supabase.from('notifications').update({ is_read: true }).eq('recipient_id', user.id);
            if (ids && ids.length) q = q.in('id', ids);
            else q = q.eq('is_read', false);
            await q;
            return res.status(200).json({ success: true });
        }

        // ══════════ PEERS (Facebook/LinkedIn-style connections) ══════════
        // Compute peer status between me and a set of other user ids.
        async function peerStatusMap(meId, otherIds) {
            const map = {};
            if (!otherIds.length) return map;
            const { data } = await supabase.from('community_peers')
                .select('requester_id, addressee_id, status')
                .or(`and(requester_id.eq.${meId},addressee_id.in.(${otherIds.join(',')})),and(addressee_id.eq.${meId},requester_id.in.(${otherIds.join(',')}))`);
            (data || []).forEach(r => {
                const other = r.requester_id === meId ? r.addressee_id : r.requester_id;
                if (r.status === 'accepted') map[other] = 'peers';
                else if (r.status === 'pending') map[other] = (r.requester_id === meId) ? 'pending_out' : 'pending_in';
            });
            return map;
        }
        async function peerCount(uid) {
            const { count } = await supabase.from('community_peers').select('id', { count: 'exact', head: true })
                .eq('status', 'accepted').or(`requester_id.eq.${uid},addressee_id.eq.${uid}`);
            return count || 0;
        }

        // ── SEND PEER REQUEST ──
        if (action === 'send_peer_request') {
            const { addressee_id, addressee_type } = req.body;
            if (!addressee_id || addressee_id === user.id) return res.status(400).json({ success: false, message: 'Invalid peer.' });
            // If they already requested me, accept instead of creating a duplicate.
            const { data: reverse } = await supabase.from('community_peers')
                .select('id, status').eq('requester_id', addressee_id).eq('addressee_id', user.id).maybeSingle();
            if (reverse) {
                if (reverse.status !== 'accepted') await supabase.from('community_peers').update({ status: 'accepted', responded_at: new Date().toISOString() }).eq('id', reverse.id);
                return res.status(200).json({ success: true, peer_status: 'peers' });
            }
            await getOrCreateProfile(user);
            const { error } = await supabase.from('community_peers')
                .upsert({ requester_id: user.id, requester_type: user.type, addressee_id, addressee_type: addressee_type || 'partner', status: 'pending', responded_at: null }, { onConflict: 'requester_id,addressee_id' });
            if (error) return res.status(400).json({ success: false, message: error.message });
            await supabase.from('notifications').insert({
                recipient_id: addressee_id, recipient_type: addressee_type || 'partner', type: 'peer_request',
                title: `${user.name} wants to connect`, body: 'Sent you a peer request', actor_id: user.id, actor_name: user.name,
                reference_id: user.id, link: (addressee_type === 'staff' ? '/staff-community?peers=1' : '/partner/community?peers=1'), is_read: false
            }).then(() => {}).catch(() => {});
            try { await supabase.from('user_notifications').insert({ user_id: addressee_id, type: 'peer_request', title: `${user.name} wants to connect`, body: 'Sent you a peer request', from_name: user.name }); } catch (e) {}
            return res.status(200).json({ success: true, peer_status: 'pending_out' });
        }

        // ── RESPOND TO A PEER REQUEST ──
        if (action === 'respond_peer_request') {
            const { requester_id, decision } = req.body;
            const status = decision === 'accept' ? 'accepted' : 'declined';
            const { data: row } = await supabase.from('community_peers')
                .select('id, requester_type').eq('requester_id', requester_id).eq('addressee_id', user.id).eq('status', 'pending').maybeSingle();
            if (!row) return res.status(404).json({ success: false, message: 'Request not found' });
            await supabase.from('community_peers').update({ status, responded_at: new Date().toISOString() }).eq('id', row.id);
            if (decision === 'accept') {
                await supabase.from('notifications').insert({
                    recipient_id: requester_id, recipient_type: row.requester_type, type: 'peer_accepted',
                    title: `${user.name} accepted your peer request`, body: 'You are now peers', actor_id: user.id, actor_name: user.name,
                    reference_id: user.id, link: (row.requester_type === 'staff' ? '/staff-community' : '/partner/community'), is_read: false
                }).then(() => {}).catch(() => {});
                try { await supabase.from('user_notifications').insert({ user_id: requester_id, type: 'peer_accepted', title: `${user.name} accepted your peer request`, body: 'You are now peers', from_name: user.name }); } catch (e) {}
            }
            return res.status(200).json({ success: true });
        }

        // ── REMOVE A PEER ──
        if (action === 'remove_peer') {
            const { peer_id } = req.body;
            await supabase.from('community_peers').delete()
                .or(`and(requester_id.eq.${user.id},addressee_id.eq.${peer_id}),and(requester_id.eq.${peer_id},addressee_id.eq.${user.id})`);
            return res.status(200).json({ success: true });
        }

        // ── LIST MY PEERS ──
        if (action === 'list_peers') {
            const { data } = await supabase.from('community_peers')
                .select('requester_id, addressee_id').eq('status', 'accepted').or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);
            const ids = [...new Set((data || []).map(r => r.requester_id === user.id ? r.addressee_id : r.requester_id))];
            let peers = [];
            if (ids.length) { const { data: profs } = await supabase.from('user_profiles').select('user_id, user_type, display_name, avatar_url, company, tagline').in('user_id', ids); peers = profs || []; }
            return res.status(200).json({ success: true, data: peers });
        }

        // ── INCOMING PEER REQUESTS (for the bell / requests view) ──
        if (action === 'list_peer_requests') {
            const { data } = await supabase.from('community_peers')
                .select('requester_id, requester_type, created_at').eq('addressee_id', user.id).eq('status', 'pending').order('created_at', { ascending: false });
            const ids = (data || []).map(r => r.requester_id);
            let profs = [];
            if (ids.length) { const { data: p } = await supabase.from('user_profiles').select('user_id, user_type, display_name, avatar_url, company, tagline').in('user_id', ids); profs = p || []; }
            const pmap = {}; profs.forEach(p => pmap[p.user_id] = p);
            const out = (data || []).map(r => ({ ...(pmap[r.requester_id] || { user_id: r.requester_id, display_name: 'Member', user_type: r.requester_type }), requested_at: r.created_at }));
            return res.status(200).json({ success: true, data: out, count: out.length });
        }

        // ── SEARCH PEOPLE (name or affiliated company) ──
        if (action === 'search_people') {
            const q = String(req.body.q || '').trim();
            if (q.length < 2) return res.status(200).json({ success: true, data: [] });
            const like = `%${q.replace(/[%,]/g, '')}%`;
            const { data } = await supabase.from('user_profiles')
                .select('user_id, user_type, display_name, avatar_url, company, tagline')
                .or(`display_name.ilike.${like},company.ilike.${like},tagline.ilike.${like}`)
                .neq('user_id', user.id).limit(30);
            const ids = (data || []).map(p => p.user_id);
            const sm = await peerStatusMap(user.id, ids);
            const out = (data || []).map(p => ({ ...p, peer_status: sm[p.user_id] || 'none' }));
            return res.status(200).json({ success: true, data: out });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('Community API Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
