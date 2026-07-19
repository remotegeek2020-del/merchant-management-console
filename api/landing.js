// ── LANDING PAGES ─────────────────────────────────────────────────────────────
// Hosted lead-capture pages at /p/<slug>. Public actions (get/submit) need no
// auth; admin actions (list/save/delete/submissions/export) require a staff
// session. Submissions can push into a GHL sub-account with tags.

import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';
import { ghlUpsertContact } from './_ghl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
const ok = (res, data) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
const PUBLIC_FIELDS = 'id, slug, title, headline, subtext, image_url, theme, contact, cta_label, thanks, is_published';

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    const body = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const action = body.action;

    try {
        // ── PUBLIC: fetch a published page by slug ──
        if (action === 'get') {
            const slug = slugify(body.slug);
            if (!slug) return bad(res, 'slug required');
            const { data } = await supabase.from('landing_pages').select(PUBLIC_FIELDS).eq('slug', slug).maybeSingle();
            if (!data || !data.is_published) return bad(res, 'Page not found', 404);
            supabase.rpc('increment_landing_view', { pid: data.id }).then(() => {}).catch(() => {});   // best-effort
            return ok(res, { page: data });
        }

        // ── PUBLIC: submit a lead ──
        if (action === 'submit') {
            const { slug } = body;
            const { data: page } = await supabase.from('landing_pages').select('id, contact, is_published').eq('slug', slugify(slug)).maybeSingle();
            if (!page || !page.is_published) return bad(res, 'Page not found', 404);
            const name = body.name ? String(body.name).slice(0, 160) : null;
            const email = body.email ? String(body.email).slice(0, 200) : null;
            const phone = body.phone ? String(body.phone).slice(0, 60) : null;
            if (!email && !phone) return bad(res, 'Provide an email or phone.');
            const country = (req.headers['x-vercel-ip-country'] || '') || null;
            await supabase.from('landing_submissions').insert({
                landing_page_id: page.id, name, email, phone, country,
                meta: (body.meta && typeof body.meta === 'object') ? body.meta : null
            });
            const cc = page.contact;
            if (cc && cc.push && cc.ghl_location_id) {
                ghlUpsertContact(cc.ghl_location_id, { name, email, phone }, cc.ghl_tags || []).catch(() => {});
            }
            return ok(res, { saved: true });
        }

        // ── ADMIN (staff session required) ──
        const session = await validateSession(req);
        if (!session) return bad(res, 'Unauthorized', 401);
        const { data: actor } = await supabase.from('app_users').select('role, first_name, last_name, access_marketing').eq('userid', session.userid).maybeSingle();
        const role = String(actor?.role || '').toLowerCase();
        if (!(role.includes('super') || role.includes('admin') || actor?.access_marketing === true)) return bad(res, 'Access denied', 403);

        if (action === 'list') {
            const { data } = await supabase.from('landing_pages')
                .select('id, slug, title, is_published, views, created_at').order('created_at', { ascending: false });
            // attach submission counts
            const ids = (data || []).map(p => p.id);
            const counts = {};
            if (ids.length) {
                const { data: subs } = await supabase.from('landing_submissions').select('landing_page_id').in('landing_page_id', ids).limit(50000);
                (subs || []).forEach(s => { counts[s.landing_page_id] = (counts[s.landing_page_id] || 0) + 1; });
            }
            return ok(res, { pages: (data || []).map(p => ({ ...p, submissions: counts[p.id] || 0 })) });
        }
        if (action === 'get_one') {
            const { data } = await supabase.from('landing_pages').select('*').eq('id', body.id).maybeSingle();
            if (!data) return bad(res, 'Not found', 404);
            return ok(res, { page: data });
        }
        if (action === 'save') {
            const p = body.page || {};
            let slug = slugify(p.slug || p.title);
            if (!slug) return bad(res, 'A title or slug is required.');
            const row = {
                slug, title: p.title || null, headline: p.headline || null, subtext: p.subtext || null,
                image_url: p.image_url || null, theme: p.theme || null, contact: p.contact || null,
                cta_label: p.cta_label || null, thanks: p.thanks || 'Thanks! We\'ll be in touch shortly.',
                is_published: !!p.is_published, updated_at: new Date().toISOString()
            };
            if (p.id) {
                const { error } = await supabase.from('landing_pages').update(row).eq('id', p.id);
                if (error) return bad(res, error.code === '23505' ? 'That URL slug is already taken.' : error.message);
                return ok(res, { id: p.id, slug });
            }
            row.created_by = `${actor?.first_name || ''} ${actor?.last_name || ''}`.trim() || session.userid;
            const { data, error } = await supabase.from('landing_pages').insert(row).select('id, slug').single();
            if (error) return bad(res, error.code === '23505' ? 'That URL slug is already taken.' : error.message);
            return ok(res, { id: data.id, slug: data.slug });
        }
        if (action === 'toggle') {
            const { error } = await supabase.from('landing_pages').update({ is_published: !!body.is_published }).eq('id', body.id);
            if (error) return bad(res, error.message);
            return ok(res, {});
        }
        if (action === 'delete') {
            const { error } = await supabase.from('landing_pages').delete().eq('id', body.id);
            if (error) return bad(res, error.message);
            return ok(res, { deleted: true });
        }
        if (action === 'submissions') {
            const { data } = await supabase.from('landing_submissions')
                .select('name, email, phone, country, created_at').eq('landing_page_id', body.id)
                .order('created_at', { ascending: false }).limit(5000);
            return ok(res, { submissions: data || [] });
        }
        if (action === 'export') {
            const { data } = await supabase.from('landing_submissions')
                .select('created_at, name, email, phone, country').eq('landing_page_id', body.id)
                .order('created_at', { ascending: false }).limit(20000);
            const esc = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
            const csv = ['created_at,name,email,phone,country'].concat((data || []).map(r => [r.created_at, r.name, r.email, r.phone, r.country].map(esc).join(','))).join('\n');
            return ok(res, { csv });
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
