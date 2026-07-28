// ── COURSES / WEBINARS (HighLevel-style membership) ─────────────────────────
// Staff (marketing access) manage courses + embedded video lessons (embed-only,
// no file storage). Partners view courses they can access. Unlock is per-course:
//   • auto   → every partner sees it once published
//   • manual → only partners explicitly granted access
// Staff actions use a session; partner actions use a partner_token.

import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
    return {
        title: String(b.title || '').slice(0, 200),
        description: b.description == null ? null : String(b.description).slice(0, 2000),
        provider: PROVIDERS.has(b.provider) ? b.provider : 'other',
        url: String(b.url || '').slice(0, 1000),
        sort_order: Number.isFinite(+b.sort_order) ? +b.sort_order : 0
    };
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
            const { data: acc } = await supabase.from('course_access').select('course_id').eq('person_id', personId);
            const granted = new Set((acc || []).map(a => a.course_id));
            const visible = all.filter(c => c.unlock_mode === 'auto' || granted.has(c.id))
                .map(c => ({ id: c.id, title: c.title, description: c.description, thumbnail_url: c.thumbnail_url, videos: c.videos.map(v => ({ id: v.id, title: v.title, description: v.description, provider: v.provider, url: v.url })) }));
            // Also show locked (manual, not granted) courses as teasers so partners know they exist.
            const locked = all.filter(c => c.unlock_mode === 'manual' && !granted.has(c.id))
                .map(c => ({ id: c.id, title: c.title, description: c.description, thumbnail_url: c.thumbnail_url, locked: true, video_count: c.videos.length }));
            return ok(res, { courses: visible, locked });
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
            return ok(res, { courses: courses.map(c => ({ ...c, access_count: counts[c.id] || 0 })) });
        }
        if (action === 'save_course') {
            const patch = {
                title: String(body.title || '').slice(0, 200),
                description: body.description == null ? null : String(body.description).slice(0, 4000),
                thumbnail_url: body.thumbnail_url ? String(body.thumbnail_url).slice(0, 1000) : null,
                unlock_mode: body.unlock_mode === 'auto' ? 'auto' : 'manual',
                is_published: !!body.is_published,
                sort_order: Number.isFinite(+body.sort_order) ? +body.sort_order : 0
            };
            if (!patch.title) return bad(res, 'Course title required.');
            if (body.id) { await supabase.from('courses').update(patch).eq('id', body.id); return ok(res, { id: body.id }); }
            const { data, error } = await supabase.from('courses').insert(patch).select('id').single();
            if (error) return bad(res, error.message);
            return ok(res, { id: data.id });
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
