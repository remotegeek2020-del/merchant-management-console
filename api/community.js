import { createClient } from '@supabase/supabase-js';
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
                .select(`id, body, image_url, is_pinned, created_at, author_id, author_type, channel_id,
                    community_channels(name, icon, color),
                    community_reactions(id, user_id, emoji),
                    community_comments(id)`, { count: 'exact' })
                .eq('is_deleted', false);
            
            if (channel_id) query = query.eq('channel_id', channel_id);
            
            const { data, count } = await query
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
            const { body, channel_id, image_url } = req.body;
            if (!body?.trim()) return res.status(400).json({ success: false, message: 'Post body required' });

            // Check announcement channel permissions
            if (channel_id) {
                const { data: channel } = await supabase.from('community_channels').select('is_announcement').eq('id', channel_id).single();
                if (channel?.is_announcement && user.type !== 'staff') {
                    return res.status(403).json({ success: false, message: 'Only staff can post in Announcements.' });
                }
            }

            await getOrCreateProfile(user);

            const { data: post, error } = await supabase.from('community_posts').insert({
                author_id: user.id,
                author_type: user.type,
                channel_id: channel_id || null,
                body: body.trim(),
                image_url: image_url || null
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
                        body: body.trim().slice(0, 100),
                        actor_id: user.id,
                        actor_name: user.name,
                        reference_id: post.id,
                        link: '/partner/community'
                    }))
                );
            }

            return res.status(200).json({ success: true, data: post });
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
            await supabase.from('channel_messages').insert({ channel_id, author_id: user.id, author_type: user.type, body: body.trim() });
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
            if (!body?.trim() || !recipient_id) return res.status(400).json({ success: false });
            await getOrCreateProfile(user);
            await supabase.from('direct_messages').insert({ sender_id: user.id, sender_type: user.type, recipient_id, recipient_type: recipient_type || 'partner', body: body.trim() });
            // Notify recipient
            await supabase.from('notifications').insert({
                recipient_id, recipient_type: recipient_type || 'partner',
                type: 'dm', title: `New message from ${user.name}`,
                body: body.trim().slice(0, 80), actor_id: user.id, actor_name: user.name,
                reference_id: user.id, link: '/partner/messages'
            });
            return res.status(200).json({ success: true });
        }

        // ── GET ALL USERS (for DM search) ─────────────────
        if (action === 'get_all_users') {
            const { search = '' } = req.body;
            const { data: profiles } = await supabase.from('user_profiles').select('user_id, display_name, avatar_url, user_type, is_online, tagline').ilike('display_name', `%${search}%`).limit(20);
            return res.status(200).json({ success: true, data: (profiles || []).filter(p => p.user_id !== user.id) });
        }

        // ── GET / UPDATE PROFILE ──────────────────────────
        if (action === 'get_profile') {
            const { profile_user_id } = req.body;
            const targetId = profile_user_id || user.id;
            const profile = await getOrCreateProfile({ id: targetId, type: user.type, name: user.name });

            // If own profile or staff, get portfolio stats for partners
            let stats = null;
            if (profile.user_type === 'partner') {
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

            return res.status(200).json({ success: true, profile, stats });
        }

        if (action === 'update_profile') {
            const { display_name, bio, tagline, phone, location, website, avatar_url } = req.body;
            const updates = {};
            if (display_name !== undefined) updates.display_name = display_name;
            if (bio !== undefined) updates.bio = bio;
            if (tagline !== undefined) updates.tagline = tagline;
            if (phone !== undefined) updates.phone = phone;
            if (location !== undefined) updates.location = location;
            if (website !== undefined) updates.website = website;
            if (avatar_url !== undefined) updates.avatar_url = avatar_url;

            await supabase.from('user_profiles').upsert({ user_id: user.id, user_type: user.type, display_name: user.name, ...updates }, { onConflict: 'user_id' });
            return res.status(200).json({ success: true });
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
            const path = `${user.id}/avatar.${ext}`;
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

        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('Community API Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
