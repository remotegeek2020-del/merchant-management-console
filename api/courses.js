// ── COURSES / WEBINARS (HighLevel-style membership) ─────────────────────────
// Staff (marketing access) manage courses + embedded video lessons (embed-only,
// no file storage). Partners view courses they can access. Unlock is per-course:
//   • auto   → every partner sees it once published
//   • manual → only partners explicitly granted access
// Staff actions use a session; partner actions use a partner_token.

import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';
import { setConfigValue, getConfigValue } from './api-config.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── YouTube auto-sync: pull a channel's live broadcasts into a course ────────
async function ytKey() { return (process.env.YOUTUBE_API_KEY || await getConfigValue('YOUTUBE_API_KEY') || '').trim(); }
async function ytFetch(path) {
    const r = await fetch('https://www.googleapis.com/youtube/v3/' + path);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || ('YouTube HTTP ' + r.status));
    return j;
}
// Accept a channel ID (UC…), a @handle, or a channel URL and resolve to a channel ID.
async function resolveChannelId(input, key) {
    const s = String(input || '').trim();
    let m = s.match(/channel\/(UC[\w-]{20,})/) || s.match(/^(UC[\w-]{20,})$/);
    if (m) return m[1];
    m = s.match(/@([A-Za-z0-9._-]+)/) || (s[0] === '@' ? [null, s.slice(1)] : null);
    if (m) { const j = await ytFetch('channels?part=id&forHandle=' + encodeURIComponent(m[1]) + '&key=' + key); if (j.items && j.items[0]) return j.items[0].id; }
    // Fallback: search for the channel by name.
    const j = await ytFetch('search?part=snippet&type=channel&maxResults=1&q=' + encodeURIComponent(s) + '&key=' + key);
    return (j.items && j.items[0]) ? j.items[0].snippet.channelId : null;
}
// Sync a course from its channel's live broadcasts (completed + in-progress).
export async function syncCourseFromYouTube(course) {
    const key = await ytKey();
    if (!key) return { ok: false, error: 'No YouTube API key set.' };
    if (!course.yt_channel_id) return { ok: false, error: 'No channel set.' };
    const channelId = await resolveChannelId(course.yt_channel_id, key);
    if (!channelId) return { ok: false, error: 'Could not resolve channel.' };
    // Gather live-broadcast video IDs (completed = past lives, live = happening now).
    const ids = [];
    for (const ev of ['completed', 'live']) {
        try {
            const j = await ytFetch('search?part=id&channelId=' + channelId + '&eventType=' + ev + '&type=video&order=date&maxResults=50&key=' + key);
            (j.items || []).forEach(it => { if (it.id && it.id.videoId) ids.push(it.id.videoId); });
        } catch (e) { /* keep going */ }
    }
    if (!ids.length) { await supabase.from('courses').update({ yt_last_sync: new Date().toISOString() }).eq('id', course.id); return { ok: true, added: 0, total: 0 }; }
    // Which are already in the course? (dedupe by youtube video id)
    const { data: existing } = await supabase.from('course_videos').select('source_ref, url').eq('course_id', course.id);
    const have = new Set();
    (existing || []).forEach(v => { if (v.source_ref) have.add(v.source_ref); const mm = String(v.url || '').match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{6,})/); if (mm) have.add(mm[1]); });
    const fresh = [...new Set(ids)].filter(id => !have.has(id));
    let added = 0;
    // Full details for the fresh ones (title, description, thumbnail, date).
    for (let i = 0; i < fresh.length; i += 50) {
        const batch = fresh.slice(i, i + 50);
        const j = await ytFetch('videos?part=snippet&id=' + batch.join(',') + '&key=' + key);
        for (const v of (j.items || [])) {
            const sn = v.snippet || {};
            const thumb = (sn.thumbnails && (sn.thumbnails.high || sn.thumbnails.medium || sn.thumbnails.default) || {}).url || null;
            await supabase.from('course_videos').insert({
                course_id: course.id, title: (sn.title || 'Live').slice(0, 200), description: (sn.description || '').slice(0, 2000),
                provider: 'youtube', url: 'https://www.youtube.com/watch?v=' + v.id, thumbnail_url: thumb,
                source: 'youtube', source_ref: v.id,
                sort_order: sn.publishedAt ? Math.floor(new Date(sn.publishedAt).getTime() / 1000) : 0
            });
            added++;
        }
    }
    await supabase.from('courses').update({ yt_last_sync: new Date().toISOString() }).eq('id', course.id);
    return { ok: true, added, total: ids.length };
}

// ── YouTube public view counts (statistics) ─────────────────────────────────
// The YouTube video id we already store as source_ref (or parse from the url).
function ytVideoId(v) {
    if (v.source_ref) return v.source_ref;
    const m = String(v.url || '').match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{6,})/);
    return m ? m[1] : null;
}
// Refresh cached YouTube statistics (viewCount/likeCount/commentCount) for a set
// of course_videos rows. Best-effort; returns how many rows were updated.
// NOTE: viewCount is the video's TOTAL public views across all of YouTube, not
// portal-only — shown alongside the portal count as context.
export async function refreshYtStatsFor(videoRows) {
    const key = await ytKey();
    if (!key) return { ok: false, error: 'No YouTube API key set.', updated: 0 };
    // Map youtube video id → our course_videos rows (a video id can repeat across courses).
    const byYt = {};
    (videoRows || []).forEach(v => { const id = ytVideoId(v); if (id) (byYt[id] = byYt[id] || []).push(v); });
    const ids = Object.keys(byYt);
    let updated = 0;
    for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        let j;
        try { j = await ytFetch('videos?part=statistics&id=' + batch.join(',') + '&key=' + key); }
        catch (e) { continue; }
        const now = new Date().toISOString();
        for (const item of (j.items || [])) {
            const st = item.statistics || {};
            const patch = {
                yt_view_count: st.viewCount != null ? parseInt(st.viewCount, 10) : null,
                yt_like_count: st.likeCount != null ? parseInt(st.likeCount, 10) : null,
                yt_comment_count: st.commentCount != null ? parseInt(st.commentCount, 10) : null,
                yt_stats_at: now
            };
            for (const row of (byYt[item.id] || [])) {
                await supabase.from('course_videos').update(patch).eq('id', row.id);
                updated++;
            }
        }
    }
    return { ok: true, updated };
}
// Refresh YouTube stats for every YouTube-backed video in the library.
export async function refreshAllYtStats() {
    const { data: vids } = await supabase.from('course_videos')
        .select('id, url, source, source_ref').limit(50000);
    const yt = (vids || []).filter(v => v.source === 'youtube' || ytVideoId(v));
    return refreshYtStatsFor(yt);
}

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
const ok = (res, data) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

async function validatePartner(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

const PROVIDERS = new Set(['youtube', 'wistia', 'vimeo', 'other']);
function cleanVideo(b) {
    const drip = parseInt(b.drip_days, 10);
    return {
        title: String(b.title || '').slice(0, 200),
        description: b.description == null ? null : String(b.description).slice(0, 2000),
        provider: PROVIDERS.has(b.provider) ? b.provider : 'other',
        url: String(b.url || '').slice(0, 1000),
        thumbnail_url: b.thumbnail_url ? String(b.thumbnail_url).slice(0, 1000) : null,
        available_on: (b.available_on && /^\d{4}-\d{2}-\d{2}$/.test(b.available_on)) ? b.available_on : null,
        drip_days: Number.isFinite(drip) && drip > 0 ? drip : 0,
        sort_order: Number.isFinite(+b.sort_order) ? +b.sort_order : 0
    };
}
// When (if ever) a video unlocks for a partner enrolled on `enrollDate`.
// Returns { available:boolean, unlock_at:ISO|null }.
function videoAvailability(v, enrollDate) {
    const now = Date.now();
    let unlock = 0;
    if (v.available_on) { const t = new Date(v.available_on + 'T00:00:00').getTime(); if (t > unlock) unlock = t; }
    if (v.drip_days && v.drip_days > 0 && enrollDate) { const t = new Date(enrollDate).getTime() + v.drip_days * 86400000; if (t > unlock) unlock = t; }
    if (unlock && unlock > now) return { available: false, unlock_at: new Date(unlock).toISOString() };
    return { available: true, unlock_at: null };
}

async function coursesWithVideos(filterPublished) {
    let q = supabase.from('courses').select('*').order('sort_order').order('created_at');
    if (filterPublished) q = q.eq('is_published', true);
    const { data: courses } = await q;
    const ids = (courses || []).map(c => c.id);
    let vids = [];
    if (ids.length) { const { data } = await supabase.from('course_videos').select('*').in('course_id', ids).order('sort_order').order('created_at'); vids = data || []; }
    const byCourse = {};
    vids.forEach(v => { (byCourse[v.course_id] = byCourse[v.course_id] || []).push(v); });
    return (courses || []).map(c => ({ ...c, videos: byCourse[c.id] || [] }));
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const body = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const action = body.action;

    try {
        // ── PARTNER: courses I can access ──
        if (action === 'my_courses') {
            const personId = await validatePartner(body.partner_token);
            if (!personId) return bad(res, 'Not signed in', 401);
            const all = await coursesWithVideos(true);
            const { data: acc } = await supabase.from('course_access').select('course_id, created_at').eq('person_id', personId);
            const granted = new Map((acc || []).map(a => [a.course_id, a.created_at]));
            const visible = all.filter(c => c.unlock_mode === 'auto' || granted.has(c.id))
                .map(c => {
                    // Enrollment baseline for drip: when the partner got access (manual) or the course date (auto).
                    const enrollDate = granted.get(c.id) || c.created_at;
                    return {
                        id: c.id, title: c.title, description: c.description, thumbnail_url: c.thumbnail_url,
                        videos: c.videos.map(v => {
                            const av = videoAvailability(v, enrollDate);
                            return { id: v.id, title: v.title, description: v.description, provider: v.provider, thumbnail_url: v.thumbnail_url, available: av.available, unlock_at: av.unlock_at, url: av.available ? v.url : null };
                        })
                    };
                });
            // Also show locked (manual, not granted) courses as teasers so partners know they exist.
            const locked = all.filter(c => c.unlock_mode === 'manual' && !granted.has(c.id))
                .map(c => ({ id: c.id, title: c.title, description: c.description, thumbnail_url: c.thumbnail_url, locked: true, video_count: c.videos.length }));
            return ok(res, { courses: visible, locked });
        }

        // ── PARTNER: log a portal view (fired when a partner plays a video) ──
        if (action === 'log_view') {
            const personId = await validatePartner(body.partner_token);
            if (!personId) return bad(res, 'Not signed in', 401);
            if (!body.video_id) return bad(res, 'video_id required');
            // Trust the DB for course_id (don't rely on the client) + confirm the video exists.
            const { data: vid } = await supabase.from('course_videos').select('id, course_id').eq('id', body.video_id).maybeSingle();
            if (!vid) return bad(res, 'Video not found', 404);
            await supabase.from('course_video_views').insert({ video_id: vid.id, course_id: vid.course_id, person_id: personId });
            return ok(res, {});
        }

        // ── STAFF (session + marketing access) ──
        const session = await validateSession(req);
        if (!session) return bad(res, 'Unauthorized', 401);
        const { data: actor } = await supabase.from('app_users').select('role, access_marketing').eq('userid', session.userid).maybeSingle();
        const role = String(actor?.role || '').toLowerCase();
        const canMarketing = role.includes('super') || role.includes('admin') || actor?.access_marketing === true;
        if (!canMarketing) return bad(res, 'Access denied. Marketing access required.', 403);

        if (action === 'courses_admin_list') {
            const courses = await coursesWithVideos(false);
            const { data: acc } = await supabase.from('course_access').select('course_id');
            const counts = {};
            (acc || []).forEach(a => { counts[a.course_id] = (counts[a.course_id] || 0) + 1; });
            // Portal view counts per video, aggregated in the DB (no 1000-row cap).
            const allVidIds = [];
            courses.forEach(c => (c.videos || []).forEach(v => allVidIds.push(v.id)));
            const viewMap = {};
            if (allVidIds.length) {
                const { data: vc } = await supabase.rpc('course_video_view_counts', { vids: allVidIds });
                (vc || []).forEach(r => { viewMap[r.video_id] = { views: Number(r.views) || 0, unique_viewers: Number(r.unique_viewers) || 0 }; });
            }
            const withStats = courses.map(c => ({
                ...c,
                access_count: counts[c.id] || 0,
                videos: (c.videos || []).map(v => ({
                    ...v,
                    portal_views: viewMap[v.id]?.views || 0,
                    portal_viewers: viewMap[v.id]?.unique_viewers || 0
                }))
            }));
            return ok(res, { courses: withStats });
        }
        // Who watched a specific video (portal viewers) — matched to the
        // HighLevel-synced partner record (persons.hl_contact_id).
        if (action === 'video_viewers') {
            if (!body.video_id) return bad(res, 'video_id required');
            const { data: rows } = await supabase.rpc('course_video_viewers', { vid: body.video_id });
            const ids = [...new Set((rows || []).map(r => r.person_id).filter(Boolean))];
            let pmap = {};
            if (ids.length) {
                const { data: persons } = await supabase.from('persons').select('id, full_name, email, phone_number, hl_contact_id').in('id', ids);
                (persons || []).forEach(p => { pmap[p.id] = p; });
            }
            const viewers = (rows || []).map(r => {
                const p = pmap[r.person_id] || {};
                return {
                    person_id: r.person_id,
                    name: p.full_name || '—',
                    email: p.email || '',
                    phone: p.phone_number || '',
                    hl_contact_id: p.hl_contact_id || null,   // matched to HighLevel
                    views: Number(r.views) || 0,
                    first_viewed: r.first_viewed,
                    last_viewed: r.last_viewed
                };
            });
            const totalViews = viewers.reduce((s, v) => s + v.views, 0);
            return ok(res, { viewers, unique_viewers: viewers.length, total_views: totalViews });
        }
        // Refresh cached YouTube view counts for the whole library.
        if (action === 'refresh_yt_stats') {
            const r = await refreshAllYtStats();
            if (!r.ok) return bad(res, r.error || 'Could not refresh (check the YouTube API key).');
            return ok(res, r);
        }
        if (action === 'save_course') {
            const patch = {
                title: String(body.title || '').slice(0, 200),
                description: body.description == null ? null : String(body.description).slice(0, 4000),
                thumbnail_url: body.thumbnail_url ? String(body.thumbnail_url).slice(0, 1000) : null,
                unlock_mode: body.unlock_mode === 'auto' ? 'auto' : 'manual',
                is_published: !!body.is_published,
                sort_order: Number.isFinite(+body.sort_order) ? +body.sort_order : 0,
                yt_channel_id: body.yt_channel_id ? String(body.yt_channel_id).trim().slice(0, 200) : null,
                yt_sync_enabled: !!body.yt_sync_enabled
            };
            if (!patch.title) return bad(res, 'Course title required.');
            if (body.id) { await supabase.from('courses').update(patch).eq('id', body.id); return ok(res, { id: body.id }); }
            const { data, error } = await supabase.from('courses').insert(patch).select('id').single();
            if (error) return bad(res, error.message);
            return ok(res, { id: data.id });
        }
        // YouTube API key (encrypted) — status + set.
        if (action === 'yt_key_status') {
            const k = await ytKey();
            return ok(res, { set: !!k, masked: k ? ('••••' + k.slice(-4)) : '' });
        }
        if (action === 'set_yt_key') {
            if (body.key && String(body.key).trim()) await setConfigValue('YOUTUBE_API_KEY', String(body.key).trim(), session.userid);
            const k = await ytKey();
            return ok(res, { set: !!k, masked: k ? ('••••' + k.slice(-4)) : '' });
        }
        // Sync a course from its YouTube channel now.
        if (action === 'sync_course') {
            const { data: course } = await supabase.from('courses').select('*').eq('id', body.course_id || body.id).maybeSingle();
            if (!course) return bad(res, 'Course not found', 404);
            const r = await syncCourseFromYouTube(course);
            if (!r.ok) return bad(res, r.error || 'Sync failed');
            return ok(res, r);
        }
        if (action === 'delete_course') { await supabase.from('courses').delete().eq('id', body.id); return ok(res, { deleted: true }); }

        if (action === 'save_video') {
            if (!body.course_id) return bad(res, 'course_id required.');
            const v = cleanVideo(body);
            if (!v.title) return bad(res, 'Video title required.');
            if (!v.url) return bad(res, 'Video embed URL required.');
            if (body.id) { await supabase.from('course_videos').update(v).eq('id', body.id); return ok(res, { id: body.id }); }
            const { data, error } = await supabase.from('course_videos').insert({ course_id: body.course_id, ...v }).select('id').single();
            if (error) return bad(res, error.message);
            return ok(res, { id: data.id });
        }
        if (action === 'delete_video') { await supabase.from('course_videos').delete().eq('id', body.id); return ok(res, { deleted: true }); }

        // Manual unlock management
        if (action === 'course_access_list') {
            const { data } = await supabase.from('course_access').select('person_id, created_at, granted_by').eq('course_id', body.course_id);
            const ids = (data || []).map(a => a.person_id);
            let persons = [];
            if (ids.length) { const { data: p } = await supabase.from('persons').select('id, full_name, email').in('id', ids); persons = p || []; }
            const pmap = {}; persons.forEach(p => { pmap[p.id] = p; });
            return ok(res, { access: (data || []).map(a => ({ person_id: a.person_id, name: pmap[a.person_id]?.full_name || '—', email: pmap[a.person_id]?.email || '', created_at: a.created_at })) });
        }
        if (action === 'partner_search') {
            const q = String(body.q || '').trim();
            if (q.length < 2) return ok(res, { partners: [] });
            const { data } = await supabase.from('persons').select('id, full_name, email').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(20);
            return ok(res, { partners: (data || []).map(p => ({ id: p.id, name: p.full_name || '—', email: p.email || '' })) });
        }
        if (action === 'grant_access') {
            if (!body.course_id || !body.person_id) return bad(res, 'course_id and person_id required.');
            await supabase.from('course_access').upsert({ course_id: body.course_id, person_id: body.person_id, granted_by: session.userid }, { onConflict: 'course_id,person_id' });
            return ok(res, {});
        }
        if (action === 'revoke_access') {
            await supabase.from('course_access').delete().eq('course_id', body.course_id).eq('person_id', body.person_id);
            return ok(res, {});
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
