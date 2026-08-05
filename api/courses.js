// ── COURSES / WEBINARS (HighLevel-style membership) ─────────────────────────
// Staff (marketing access) manage courses + embedded video lessons (embed-only,
// no file storage). Partners view courses they can access. Unlock is per-course:
//   • auto   → every partner sees it once published
//   • manual → only partners explicitly granted access
// Staff actions use a session; partner actions use a partner_token.

import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';
import { setConfigValue, getConfigValue } from './api-config.js';
import { canMarketingSettings } from './_access.js';
import { logActivity } from './_activity.js';
import { ytAnalyticsConfigured, fetchVideoAnalytics } from './youtube-oauth.js';
import { ghlListForms, ghlListCalendars, ghlLocationNames, ghlCalendarAppointments, ghlFormSubmissions, ghlContactInfo } from './_ghl.js';

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
    // Gather live-broadcast video IDs: completed = past lives, live = happening
    // now, upcoming = scheduled streams (shown as "coming [date]" until they air).
    const ids = [];
    for (const ev of ['completed', 'live', 'upcoming']) {
        try {
            const j = await ytFetch('search?part=id&channelId=' + channelId + '&eventType=' + ev + '&type=video&order=date&maxResults=50&key=' + key);
            (j.items || []).forEach(it => { if (it.id && it.id.videoId) ids.push(it.id.videoId); });
        } catch (e) { /* keep going */ }
    }
    if (!ids.length) { await supabase.from('courses').update({ yt_last_sync: new Date().toISOString() }).eq('id', course.id); return { ok: true, added: 0, updated: 0, total: 0 }; }
    const parseYt = (u) => { const mm = String(u || '').match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{6,})/); return mm ? mm[1] : null; };
    // Map YouTube id → our existing row id, so we can UPDATE dates (not just insert).
    const { data: existing } = await supabase.from('course_videos').select('id, source_ref, url').eq('course_id', course.id);
    const rowByYt = {};
    (existing || []).forEach(v => { const yid = v.source_ref || parseYt(v.url); if (yid) rowByYt[yid] = v.id; });
    const uniqIds = [...new Set(ids)];
    let added = 0, updated = 0;
    for (let i = 0; i < uniqIds.length; i += 50) {
        const batch = uniqIds.slice(i, i + 50);
        const j = await ytFetch('videos?part=snippet,liveStreamingDetails&id=' + batch.join(',') + '&key=' + key);
        for (const v of (j.items || [])) {
            const sn = v.snippet || {};
            const lsd = v.liveStreamingDetails || {};
            // Release date = the stream's own timestamp (scheduled for upcoming,
            // actual start once aired, else published). Future date locks it as a
            // "coming [date]" teaser; a past date is when it aired.
            const ts = lsd.scheduledStartTime || lsd.actualStartTime || sn.publishedAt;
            const available_on = ts ? new Date(ts).toISOString().slice(0, 10) : null;
            const sort_order = ts ? Math.floor(new Date(ts).getTime() / 1000) : 0;
            const existingId = rowByYt[v.id];
            if (existingId) {
                // Keep the (possibly hand-edited) title/description; just correct the date.
                await supabase.from('course_videos').update({ available_on, sort_order }).eq('id', existingId);
                updated++;
            } else {
                const thumb = (sn.thumbnails && (sn.thumbnails.high || sn.thumbnails.medium || sn.thumbnails.default) || {}).url || null;
                await supabase.from('course_videos').insert({
                    course_id: course.id, title: (sn.title || 'Live').slice(0, 200), description: (sn.description || '').slice(0, 2000),
                    provider: 'youtube', url: 'https://www.youtube.com/watch?v=' + v.id, thumbnail_url: thumb,
                    source: 'youtube', source_ref: v.id, available_on, sort_order
                });
                added++;
            }
        }
    }
    await supabase.from('courses').update({ yt_last_sync: new Date().toISOString() }).eq('id', course.id);
    return { ok: true, added, updated, total: ids.length };
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
        sort_order: Number.isFinite(+b.sort_order) ? +b.sort_order : 0,
        // Per-video AI guidance (keeps auto-replies grounded + goal-driven).
        ai_context: b.ai_context == null ? null : String(b.ai_context).slice(0, 4000),
        ai_goal: ['appointment', 'signup'].includes(b.ai_goal) ? b.ai_goal : 'none',
        ai_cta_link: b.ai_cta_link ? String(b.ai_cta_link).slice(0, 1000) : null,
        ai_cta_label: b.ai_cta_label ? String(b.ai_cta_label).slice(0, 200) : null,
        ai_cta_ref: b.ai_cta_ref ? String(b.ai_cta_ref).slice(0, 200) : null
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
    // Sort by RELEASE DATE — newest / upcoming first (nulls last). sort_order is a
    // finer tiebreaker for same-day items.
    if (ids.length) { const { data } = await supabase.from('course_videos').select('*').in('course_id', ids).order('available_on', { ascending: false, nullsFirst: false }).order('sort_order', { ascending: false }).order('created_at', { ascending: false }); vids = data || []; }
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
                            const hasCta = av.available && v.ai_goal && v.ai_goal !== 'none';
                            return { id: v.id, title: v.title, description: v.description, provider: v.provider, thumbnail_url: v.thumbnail_url, available: av.available, unlock_at: av.unlock_at, url: av.available ? v.url : null, cta_url: hasCta ? (v.ai_cta_link || null) : null, cta_label: v.ai_cta_label || (v.ai_goal === 'signup' ? 'Sign up' : 'Book an appointment') };
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
        const { data: actor } = await supabase.from('app_users').select('userid, email, first_name, last_name, role, is_active, access_marketing, access_marketing_settings').eq('userid', session.userid).maybeSingle();
        const role = String(actor?.role || '').toLowerCase();
        const canMarketing = role.includes('super') || role.includes('admin') || actor?.access_marketing === true;
        if (!canMarketing) return bad(res, 'Access denied. Marketing access required.', 403);
        const actorEmail = actor?.email || session.userid;
        const actorNm = `${actor?.first_name || ''} ${actor?.last_name || ''}`.trim() || actorEmail;
        const log = (fields) => logActivity({ email: actorEmail, category: 'marketing', ...fields }, req);

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
            // Open (unreplied) YouTube comments per video → badge on the row.
            const openComments = {};
            if (allVidIds.length) {
                const { data: oc } = await supabase.from('youtube_comments')
                    .select('course_video_id').eq('replied', false).in('course_video_id', allVidIds).limit(50000);
                (oc || []).forEach(r => { openComments[r.course_video_id] = (openComments[r.course_video_id] || 0) + 1; });
            }
            // QR scans per video (aggregated in DB).
            const qrMap = {};
            if (allVidIds.length) {
                const { data: qs } = await supabase.rpc('qr_scan_counts', { vids: allVidIds });
                (qs || []).forEach(r => { qrMap[r.course_video_id] = Number(r.scans) || 0; });
            }
            const withStats = courses.map(c => ({
                ...c,
                access_count: counts[c.id] || 0,
                videos: (c.videos || []).map(v => ({
                    ...v,
                    portal_views: viewMap[v.id]?.views || 0,
                    portal_viewers: viewMap[v.id]?.unique_viewers || 0,
                    open_comments: openComments[v.id] || 0,
                    qr_scans: qrMap[v.id] || 0
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
            const leadIds = [...new Set((rows || []).map(r => r.lead_id).filter(Boolean))];
            let pmap = {}, lmap = {};
            if (ids.length) {
                const { data: persons } = await supabase.from('persons').select('id, full_name, email, phone_number, hl_contact_id').in('id', ids);
                (persons || []).forEach(p => { pmap[p.id] = p; });
            }
            if (leadIds.length) {
                const { data: leads } = await supabase.from('leads').select('id, full_name, email, phone, ghl_contact_id').in('id', leadIds);
                (leads || []).forEach(l => { lmap[l.id] = l; });
            }
            const viewers = (rows || []).map(r => {
                if (r.lead_id) {
                    const l = lmap[r.lead_id] || {};
                    return {
                        person_id: null, lead_id: r.lead_id, viewer_type: 'prospect',
                        name: (l.full_name || l.email || 'Prospect') + ' (Prospect)',
                        email: l.email || '', phone: l.phone || '',
                        hl_contact_id: l.ghl_contact_id || null,
                        views: Number(r.views) || 0, first_viewed: r.first_viewed, last_viewed: r.last_viewed
                    };
                }
                const p = pmap[r.person_id] || {};
                return {
                    person_id: r.person_id, lead_id: null, viewer_type: 'partner',
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
        // Per-video analytics popup (aggregate YouTube data + our portal counts).
        if (action === 'video_analytics') {
            if (!body.video_id) return bad(res, 'video_id required');
            const { data: v } = await supabase.from('course_videos')
                .select('id, url, title, source, source_ref, yt_view_count, yt_like_count, yt_comment_count, yt_portal_views, yt_stats_at')
                .eq('id', body.video_id).maybeSingle();
            if (!v) return bad(res, 'Video not found', 404);
            const ytid = v.source_ref || (String(v.url || '').match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{6,})/) || [])[1] || null;
            let connected = false, analytics = null;
            if (ytid) {
                connected = await ytAnalyticsConfigured();
                if (connected) { try { analytics = await fetchVideoAnalytics(ytid); } catch (e) { /* best-effort */ } }
            }
            let portal = { views: 0, unique_viewers: 0 };
            const { data: vc } = await supabase.rpc('course_video_view_counts', { vids: [v.id] });
            if (vc && vc[0]) portal = { views: Number(vc[0].views) || 0, unique_viewers: Number(vc[0].unique_viewers) || 0 };
            return ok(res, {
                title: v.title,
                youtube_id: ytid,
                cached: { views: v.yt_view_count, likes: v.yt_like_count, comments: v.yt_comment_count, portal_views: v.yt_portal_views, at: v.yt_stats_at },
                portal, connected, analytics
            });
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
                lead_visible: !!body.lead_visible,
                sort_order: Number.isFinite(+body.sort_order) ? +body.sort_order : 0,
                yt_channel_id: body.yt_channel_id ? String(body.yt_channel_id).trim().slice(0, 200) : null,
                yt_sync_enabled: !!body.yt_sync_enabled
            };
            if (!patch.title) return bad(res, 'Course title required.');
            if (body.id) {
                await supabase.from('courses').update(patch).eq('id', body.id);
                log({ action: `${actorNm} updated course "${patch.title}"`, target_type: 'course', target_id: body.id, new_value: patch });
                return ok(res, { id: body.id });
            }
            const { data, error } = await supabase.from('courses').insert(patch).select('id').single();
            if (error) return bad(res, error.message);
            log({ action: `${actorNm} created course "${patch.title}"`, target_type: 'course', target_id: data.id, new_value: patch });
            return ok(res, { id: data.id });
        }
        // YouTube API key (encrypted) — status + set.
        if (action === 'yt_key_status') {
            const k = await ytKey();
            return ok(res, { set: !!k, masked: k ? ('••••' + k.slice(-4)) : '' });
        }
        if (action === 'set_yt_key') {
            // Sensitive integration key — requires the granular Marketing Settings access.
            if (!canMarketingSettings(actor)) return bad(res, 'Access denied. Marketing Settings access required.', 403);
            if (body.key && String(body.key).trim()) await setConfigValue('YOUTUBE_API_KEY', String(body.key).trim(), session.userid);
            const k = await ytKey();
            log({ action: `${actorNm} updated the YouTube Data API key`, target_type: 'marketing_setting', target_id: 'youtube_api_key' });
            return ok(res, { set: !!k, masked: k ? ('••••' + k.slice(-4)) : '' });
        }
        // Sync a course from its YouTube channel now.
        if (action === 'sync_course') {
            const { data: course } = await supabase.from('courses').select('*').eq('id', body.course_id || body.id).maybeSingle();
            if (!course) return bad(res, 'Course not found', 404);
            const r = await syncCourseFromYouTube(course);
            if (!r.ok) return bad(res, r.error || 'Sync failed');
            log({ action: `${actorNm} synced YouTube lives into "${course.title}" (${r.added || 0} added)`, target_type: 'course', target_id: course.id });
            return ok(res, r);
        }
        if (action === 'delete_course') {
            const { data: course } = await supabase.from('courses').select('title').eq('id', body.id).maybeSingle();
            await supabase.from('courses').delete().eq('id', body.id);
            log({ action: `${actorNm} deleted course "${course?.title || body.id}"`, severity: 'warning', target_type: 'course', target_id: body.id });
            return ok(res, { deleted: true });
        }

        if (action === 'save_video') {
            if (!body.course_id) return bad(res, 'course_id required.');
            const v = cleanVideo(body);
            if (!v.title) return bad(res, 'Video title required.');
            if (!v.url) return bad(res, 'Video embed URL required.');
            if (body.id) {
                // Don't reset ordering/date fields the edit form didn't send.
                const patch = { ...v };
                if (body.sort_order === undefined) delete patch.sort_order;
                await supabase.from('course_videos').update(patch).eq('id', body.id);
                log({ action: `${actorNm} updated video "${v.title}"`, target_type: 'course_video', target_id: body.id });
                return ok(res, { id: body.id });
            }
            const { data, error } = await supabase.from('course_videos').insert({ course_id: body.course_id, ...v }).select('id').single();
            if (error) return bad(res, error.message);
            log({ action: `${actorNm} added video "${v.title}"`, target_type: 'course_video', target_id: data.id });
            return ok(res, { id: data.id });
        }
        if (action === 'delete_video') {
            await supabase.from('course_videos').delete().eq('id', body.id);
            log({ action: `${actorNm} deleted a video`, severity: 'warning', target_type: 'course_video', target_id: body.id });
            return ok(res, { deleted: true });
        }

        // Manual unlock management
        if (action === 'course_access_list') {
            const { data } = await supabase.from('course_access').select('person_id, created_at, granted_by').eq('course_id', body.course_id);
            const ids = (data || []).map(a => a.person_id);
            let persons = [];
            if (ids.length) { const { data: p } = await supabase.from('persons').select('id, full_name, email').in('id', ids); persons = p || []; }
            const pmap = {}; persons.forEach(p => { pmap[p.id] = p; });
            return ok(res, { access: (data || []).map(a => ({ person_id: a.person_id, name: pmap[a.person_id]?.full_name || '—', email: pmap[a.person_id]?.email || '', created_at: a.created_at })) });
        }
        // Ensure a QR/tracking code exists for a video → returns the /go/<code> link.
        if (action === 'qr_setup') {
            if (!body.video_id) return bad(res, 'video_id required');
            const { data: v } = await supabase.from('course_videos').select('id, qr_code, qr_enabled, ai_cta_link, ai_goal').eq('id', body.video_id).maybeSingle();
            if (!v) return bad(res, 'Video not found', 404);
            if (!v.ai_cta_link) return ok(res, { needs_link: true });
            let code = v.qr_code;
            if (!code) {
                // Unique short slug; retry on the rare collision.
                for (let i = 0; i < 5 && !code; i++) {
                    const cand = Array.from({ length: 8 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)]).join('');
                    const { error } = await supabase.from('course_videos').update({ qr_code: cand, qr_enabled: true }).eq('id', v.id).is('qr_code', null);
                    if (!error) { const { data: chk } = await supabase.from('course_videos').select('qr_code').eq('id', v.id).maybeSingle(); code = chk?.qr_code; }
                }
            } else if (!v.qr_enabled) {
                await supabase.from('course_videos').update({ qr_enabled: true }).eq('id', v.id);
            }
            if (!code) return bad(res, 'Could not create QR code');
            const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            log({ action: `${actorNm} generated a QR code for a video`, target_type: 'course_video', target_id: v.id });
            return ok(res, { code, link: `${proto}://${host}/go/${code}`, target: v.ai_cta_link, type: v.ai_goal });
        }
        if (action === 'qr_stats') {
            if (!body.video_id) return bad(res, 'video_id required');
            const { count } = await supabase.from('qr_scans').select('id', { count: 'exact', head: true }).eq('course_video_id', body.video_id);
            const { data: last } = await supabase.from('qr_scans').select('scanned_at').eq('course_video_id', body.video_id).order('scanned_at', { ascending: false }).limit(1);
            return ok(res, { scans: count || 0, last_scan: last?.[0]?.scanned_at || null });
        }
        // Bookings / signups that came from this video's QR (matched in HighLevel).
        if (action === 'qr_conversions') {
            if (!body.video_id) return bad(res, 'video_id required');
            const { data: v } = await supabase.from('course_videos').select('id, ai_goal, ai_cta_ref, ai_cta_link, created_at').eq('id', body.video_id).maybeSingle();
            if (!v) return bad(res, 'Video not found', 404);
            const locationId = (await getConfigValue('GHL_LOCATION_ID')) || process.env.GHL_LOCATION_ID;
            if (!locationId) return ok(res, { configured: false });
            const parseId = (re) => { const m = String(v.ai_cta_link || '').match(re); return m ? m[1] : null; };
            const calId = v.ai_goal === 'appointment' ? (v.ai_cta_ref || parseId(/widget\/bookings?\/([A-Za-z0-9]+)/)) : null;
            const formId = v.ai_goal === 'signup' ? (v.ai_cta_ref || parseId(/widget\/form\/([A-Za-z0-9]+)/)) : null;
            if (!calId && !formId) return ok(res, { configured: false, reason: 'no calendar/form set for this video' });
            const startMs = v.created_at ? new Date(v.created_at).getTime() : Date.now() - 180 * 864e5;
            const endMs = Date.now();
            const list = calId ? await ghlCalendarAppointments(locationId, calId, startMs, endMs) : await ghlFormSubmissions(locationId, formId, startMs, endMs);
            // Attribute to THIS QR via the contact's captured UTM (portal_qr / video id).
            const withId = (list || []).filter(x => x.contact_id).slice(0, 300);
            let qr = 0;
            for (let i = 0; i < withId.length; i += 8) {
                const batch = withId.slice(i, i + 8);
                await Promise.all(batch.map(async x => {
                    const info = await ghlContactInfo(locationId, x.contact_id);
                    if (String(info.source || '').toLowerCase().includes('portal_qr') || String(info.campaign || '') === String(v.id)) qr++;
                }));
            }
            return ok(res, { configured: true, type: calId ? 'appointment' : 'signup', total: (list || []).length, qr_attributed: qr });
        }
        if (action === 'qr_disable') {
            if (!body.video_id) return bad(res, 'video_id required');
            await supabase.from('course_videos').update({ qr_enabled: false }).eq('id', body.video_id);
            log({ action: `${actorNm} disabled a video QR code`, target_type: 'course_video', target_id: body.video_id });
            return ok(res, { disabled: true });
        }
        // Detect an embedded HighLevel form/calendar from a page URL, OR from
        // pasted embed code / a direct widget link (no fetch needed).
        if (action === 'detect_embed') {
            const input = String(body.url || '').trim();
            if (!input) return bad(res, 'Paste a page URL, the embed code, or the calendar/form link.');
            let html = '';
            // If they pasted embed code or a widget/booking link, scan it directly.
            if (/leadconnector|msgsndr|<iframe|widget\/(form|booking)|data-(form|calendar|widget)-id/i.test(input)) {
                html = input;
            }
            if (!html) {
                if (!/^https?:\/\//i.test(input)) return bad(res, 'Enter a valid http(s) URL, or paste the embed code / calendar link.');
                try {
                    const r = await fetch(input, { headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-US,en;q=0.9'
                    } });
                    html = await r.text().catch(() => '');
                    if (!r.ok && !/leadconnector|msgsndr|widget\//i.test(html)) {
                        return bad(res, `The site blocked our request (HTTP ${r.status}) or loads the calendar with JavaScript. Paste the embed code or the calendar link instead.`);
                    }
                } catch (e) { return bad(res, 'Could not fetch that page. Paste the embed code or the calendar link instead.'); }
            }
            // Same proven detection as the campaign "Scan CTA" (domain-agnostic).
            const hay = input + '\n' + html;
            const grab = (re) => { const m = hay.match(re); return m ? m[1] : null; };
            const formId = grab(/widget\/form\/([A-Za-z0-9]{6,40})/) || grab(/data-form-id=["']([A-Za-z0-9]{6,40})["']/) || grab(/[?&]formId=([A-Za-z0-9]{6,40})/);
            const calId = grab(/widget\/bookings?\/([A-Za-z0-9]{6,40})/) || grab(/data-(?:calendar|widget)-id=["']([A-Za-z0-9]{6,40})["']/) || grab(/[?&]calendarId=([A-Za-z0-9]{6,40})/) || grab(/\/widget\/appointment\/([A-Za-z0-9]{6,40})/);
            if (!formId && !calId) return ok(res, { found: false });
            // If they gave us THEIR external page (not a raw widget/embed), that's
            // the link the AI should share — the branded page they built.
            const isHttp = /^https?:\/\//i.test(input);
            const directWidget = /^https?:\/\/[^\/]*(leadconnectorhq|msgsndr)\.com\/(widget|js)\//i.test(input);
            const pageUrl = (isHttp && !directWidget) ? input : null;
            // Name them from the HighLevel lists where possible.
            const locationId = (await getConfigValue('GHL_LOCATION_ID')) || process.env.GHL_LOCATION_ID;
            let forms = [], cals = [];
            if (locationId) { try { [forms, cals] = await Promise.all([ghlListForms(locationId), ghlListCalendars(locationId)]); } catch (e) { /* names optional */ } }
            const results = [];
            if (calId) { const hit = (cals || []).find(x => x.id === calId); results.push({ type: 'appointment', id: calId, name: hit ? hit.name : '', link: 'https://api.leadconnectorhq.com/widget/booking/' + calId }); }
            if (formId) { const hit = (forms || []).find(x => x.id === formId); results.push({ type: 'signup', id: formId, name: hit ? hit.name : '', link: 'https://api.leadconnectorhq.com/widget/form/' + formId }); }
            return ok(res, { found: true, results, page_url: pageUrl });
        }
        // HighLevel forms + calendars for the configured location (CTA picker).
        if (action === 'ghl_cta_options') {
            const locationId = (await getConfigValue('GHL_LOCATION_ID')) || process.env.GHL_LOCATION_ID;
            if (!locationId) return ok(res, { configured: false, forms: [], calendars: [] });
            const [forms, calendars, names] = await Promise.all([
                ghlListForms(locationId), ghlListCalendars(locationId), ghlLocationNames([locationId])
            ]);
            return ok(res, { configured: true, location_id: locationId, location_name: names[locationId] || '', forms: forms || [], calendars: calendars || [] });
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
            log({ action: `${actorNm} granted course access to a partner`, target_type: 'course_access', target_id: body.course_id, new_value: { person_id: body.person_id } });
            return ok(res, {});
        }
        if (action === 'revoke_access') {
            await supabase.from('course_access').delete().eq('course_id', body.course_id).eq('person_id', body.person_id);
            log({ action: `${actorNm} revoked course access from a partner`, severity: 'warning', target_type: 'course_access', target_id: body.course_id, new_value: { person_id: body.person_id } });
            return ok(res, {});
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
