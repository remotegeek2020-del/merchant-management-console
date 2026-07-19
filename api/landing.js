// ── LANDING PAGES ─────────────────────────────────────────────────────────────
// Hosted lead-capture pages at /p/<slug>. Public actions (get/submit) need no
// auth; admin actions (list/save/delete/submissions/export) require a staff
// session. Submissions can push into a GHL sub-account with tags.

import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';
import { ghlUpsertContact } from './_ghl.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } }, maxDuration: 120 };

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
const PUBLIC_FIELDS = 'id, slug, title, headline, subtext, image_url, theme, contact, cta_label, thanks, is_published, custom_html, page_type, calc';

// Strip anything unsafe/non-self-contained from AI/hand HTML (scripts, iframes,
// external/event handlers) so a published page can't run arbitrary JS.
function sanitizePageHtml(html) {
    let h = String(html || '');
    h = h.replace(/```html/gi, '').replace(/```/g, '').trim();
    // Keep only the body if a full doc came back.
    const bodyM = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyM) h = bodyM[1];
    h = h.replace(/<!doctype[^>]*>/gi, '').replace(/<\/?html[^>]*>/gi, '').replace(/<head[\s\S]*?<\/head>/gi, '');
    h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
    h = h.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    h = h.replace(/\son\w+\s*=\s*"[^"]*"/gi, '').replace(/\son\w+\s*=\s*'[^']*'/gi, '');
    h = h.replace(/javascript:/gi, '');
    return h.trim();
}

async function generatePageHtml(userPrompt, existingHtml) {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview', generationConfig: { temperature: 0.8 } });
    const rules = `You design high-converting, modern, responsive LANDING PAGES for PayProTec (a payment-processing / merchant-services company).
Return ONLY HTML for the page body — no markdown fences, no <html>, <head>, <body>, and NO <script> tags.
STRICT RULES:
- Self-contained: use a single <style> block (scope selectors under a wrapper class you create) and/or inline styles. No external CSS, fonts, images, or JS.
- Do not reference external images. Use CSS gradients/shapes/emoji for visuals instead of <img> with external src.
- Modern, clean, conversion-focused: a strong hero with headline + subhead, benefits/features, social proof, and a clear lead-capture section.
- Mobile responsive (use flexbox/grid, relative units, media queries).
- MUST include exactly one lead form: <form id="lead-form"> containing at minimum <input name="email" type="email" placeholder="Email"> plus <input name="name"> and/or <input name="phone"> as appropriate, and a submit <button type="submit">. Do NOT add any form action or JS — the platform wires submission automatically.
- Keep copy realistic for merchant services (lower processing fees, next-day funding, free terminals, dedicated support, etc.) unless the user says otherwise.`;
    const prompt = existingHtml
        ? `${rules}\n\nHere is the CURRENT page HTML:\n${existingHtml}\n\nApply this change and return the FULL updated page HTML:\n"${userPrompt}"`
        : `${rules}\n\nCreate a landing page for this request:\n"${userPrompt}"`;
    const result = await model.generateContent(prompt);
    const text = (await result.response).text();
    return sanitizePageHtml(text);
}

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
            // Referral attribution (?ref=<partner code>).
            const refCode = body.ref ? String(body.ref).slice(0, 40) : null;
            let referredBy = null;
            if (refCode) {
                const { data: ref } = await supabase.from('persons').select('id').eq('referral_code', refCode).maybeSingle();
                referredBy = ref?.id || null;
            }
            await supabase.from('landing_submissions').insert({
                landing_page_id: page.id, name, email, phone, country,
                referred_by: referredBy, ref_code: refCode,
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
        if (action === 'ai_generate') {
            const p = String(body.prompt || '').trim();
            if (!p) return bad(res, 'Describe the page you want.');
            try {
                const html = await generatePageHtml(p, body.existing_html ? String(body.existing_html) : null);
                if (!html) return bad(res, 'The AI returned nothing — try rephrasing.');
                return ok(res, { html });
            } catch (e) { return bad(res, 'AI error: ' + (e.message || 'unknown'), 500); }
        }
        if (action === 'save') {
            const p = body.page || {};
            let slug = slugify(p.slug || p.title);
            if (!slug) return bad(res, 'A title or slug is required.');
            const row = {
                slug, title: p.title || null, headline: p.headline || null, subtext: p.subtext || null,
                image_url: p.image_url || null, theme: p.theme || null, contact: p.contact || null,
                cta_label: p.cta_label || null, thanks: p.thanks || 'Thanks! We\'ll be in touch shortly.',
                custom_html: p.custom_html ? sanitizePageHtml(p.custom_html) : null,
                page_type: p.page_type === 'calculator' ? 'calculator' : 'standard',
                calc: (p.calc && typeof p.calc === 'object') ? { target_rate: Math.max(0, Math.min(10, parseFloat(p.calc.target_rate) || 2.3)) } : null,
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
