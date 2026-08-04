// ── Lead Portal API ─────────────────────────────────────────────────────────
// Two audiences:
//  • STAFF (Marketing → Lead Portal, gated by access_lead_portal): build the
//    onboarding survey + view leads/stats/answers.
//  • LEADS (prospective partners): self-register, log in, answer onboarding.
// Leads are isolated from persons/partner data until they graduate to partner.
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { validateSession } from './_validate.js';
import { loadActor, actorName, canLeadPortal } from './_access.js';
import { logActivity } from './_activity.js';
import { getConfigValue } from './api-config.js';
import { ghlListCalendars, ghlLocationNames } from './_ghl.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ok = (res, data) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
const QTYPES = new Set(['short_text', 'long_text', 'multiple_choice', 'checkboxes', 'dropdown', 'yes_no', 'number']);
const token = () => crypto.randomBytes(32).toString('hex');

async function validateLead(t) {
    if (!t) return null;
    const { data } = await supabase.from('lead_sessions').select('lead_id, expires_at').eq('session_token', t).maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.lead_id;
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const body = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const action = body.action;
    try {
        // ══════════ LEAD (self-serve) actions ══════════
        if (action === 'lead_register') {
            const email = String(body.email || '').toLowerCase().trim();
            const full_name = String(body.full_name || '').trim();
            const phone = String(body.phone || '').trim();
            const password = String(body.password || '');
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'A valid email is required.');
            if (!full_name) return bad(res, 'Your name is required.');
            if (password.length < 6) return bad(res, 'Password must be at least 6 characters.');
            const { data: existing } = await supabase.from('leads').select('id').eq('email', email).maybeSingle();
            if (existing) return bad(res, 'An account with this email already exists. Try signing in.', 409);
            const password_hash = await bcrypt.hash(password, 12);
            const { data: lead, error } = await supabase.from('leads')
                .insert({ email, full_name, phone, password_hash, source: String(body.source || 'lead_portal').slice(0, 60) })
                .select('id, full_name, email, onboarding_completed').single();
            if (error) return bad(res, error.message);
            const t = token();
            await supabase.from('lead_sessions').insert({ session_token: t, lead_id: lead.id, expires_at: new Date(Date.now() + 7 * 864e5).toISOString() });
            // Best-effort GHL contact (marks them a real, opted-in lead).
            try {
                const { ghlUpsertContact } = await import('./_ghl.js');
                const locationId = (await import('./api-config.js')).getConfigValue ? await (await import('./api-config.js')).getConfigValue('GHL_LOCATION_ID') : null;
                if (locationId) { const r = await ghlUpsertContact(locationId, { name: full_name, email, phone }, ['lead portal']); if (r?.id) await supabase.from('leads').update({ ghl_contact_id: r.id }).eq('id', lead.id); }
            } catch (e) { /* non-blocking */ }
            return ok(res, { token: t, lead: { id: lead.id, full_name: lead.full_name, email: lead.email, onboarding_completed: false } });
        }
        if (action === 'lead_login') {
            const email = String(body.email || '').toLowerCase().trim();
            const { data: lead } = await supabase.from('leads').select('id, full_name, email, password_hash, onboarding_completed, status').eq('email', email).maybeSingle();
            if (!lead || !lead.password_hash || !(await bcrypt.compare(String(body.password || ''), lead.password_hash))) return bad(res, 'Invalid email or password.', 401);
            const t = token();
            await supabase.from('lead_sessions').insert({ session_token: t, lead_id: lead.id, expires_at: new Date(Date.now() + 7 * 864e5).toISOString() });
            await supabase.from('leads').update({ last_login: new Date().toISOString() }).eq('id', lead.id);
            return ok(res, { token: t, lead: { id: lead.id, full_name: lead.full_name, email: lead.email, onboarding_completed: lead.onboarding_completed, status: lead.status } });
        }
        if (action === 'lead_validate') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const { data: lead } = await supabase.from('leads').select('id, full_name, email, phone, onboarding_completed, status, assigned_rep').eq('id', leadId).maybeSingle();
            return ok(res, { lead });
        }
        if (action === 'lead_logout') {
            if (body.token) await supabase.from('lead_sessions').delete().eq('session_token', body.token);
            return ok(res, {});
        }
        if (action === 'lead_get_onboarding') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const { data: qs } = await supabase.from('lead_onboarding_questions').select('id, question, help_text, type, options, required, sort_order').eq('is_active', true).order('sort_order').order('created_at');
            const { data: ans } = await supabase.from('lead_onboarding_answers').select('question_id, answer').eq('lead_id', leadId);
            const amap = {}; (ans || []).forEach(a => { amap[a.question_id] = a.answer; });
            return ok(res, { questions: (qs || []).map(q => ({ ...q, answer: amap[q.id] ?? null })) });
        }
        if (action === 'lead_submit_onboarding') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const answers = Array.isArray(body.answers) ? body.answers : [];
            // Validate required questions are answered.
            const { data: qs } = await supabase.from('lead_onboarding_questions').select('id, question, required, type').eq('is_active', true);
            const amap = {}; answers.forEach(a => { amap[a.question_id] = a.answer; });
            for (const q of (qs || [])) {
                if (q.required) {
                    const v = amap[q.id];
                    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
                    if (empty) return bad(res, `Please answer: ${q.question}`);
                }
            }
            for (const a of answers) {
                if (!a || !a.question_id) continue;
                await supabase.from('lead_onboarding_answers').upsert({ lead_id: leadId, question_id: a.question_id, answer: a.answer ?? null }, { onConflict: 'lead_id,question_id' });
            }
            await supabase.from('leads').update({ onboarding_completed: true }).eq('id', leadId);
            return ok(res, {});
        }
        // Courses for leads: published, auto-unlock courses + their videos.
        if (action === 'lead_courses') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const { data: courses } = await supabase.from('courses').select('id, title, description, thumbnail_url')
                .eq('is_published', true).eq('unlock_mode', 'auto').order('sort_order').order('created_at');
            const ids = (courses || []).map(c => c.id);
            let vids = [];
            if (ids.length) {
                const { data } = await supabase.from('course_videos').select('id, course_id, title, description, provider, url, thumbnail_url, available_on')
                    .in('course_id', ids).order('available_on', { ascending: false, nullsFirst: false }).order('sort_order').limit(50000);
                vids = data || [];
            }
            const now = Date.now();
            const byCourse = {};
            vids.forEach(v => {
                const avail = !v.available_on || new Date(v.available_on + 'T00:00:00').getTime() <= now;
                (byCourse[v.course_id] = byCourse[v.course_id] || []).push({ id: v.id, title: v.title, description: v.description, provider: v.provider, url: avail ? v.url : null, available: avail, unlock_at: avail ? null : v.available_on, thumbnail_url: v.thumbnail_url });
            });
            return ok(res, { courses: (courses || []).map(c => ({ ...c, videos: byCourse[c.id] || [] })) });
        }
        // Announcements for leads (read-only) — from the community announcements channel.
        if (action === 'lead_announcements') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const { data: posts } = await supabase.from('community_posts')
                .select('id, body, image_url, cta_label, cta_url, created_at, author_id')
                .eq('is_announcement', true).eq('is_deleted', false).order('created_at', { ascending: false }).limit(30);
            const ids = [...new Set((posts || []).map(p => p.author_id))];
            let profs = [];
            if (ids.length) { const { data } = await supabase.from('user_profiles').select('user_id, display_name, avatar_url').in('user_id', ids); profs = data || []; }
            const pmap = {}; profs.forEach(p => { pmap[p.user_id] = p; });
            return ok(res, { announcements: (posts || []).map(p => ({ id: p.id, body: p.body, image_url: p.image_url, cta_label: p.cta_label, cta_url: p.cta_url, created_at: p.created_at, author: (pmap[p.author_id] || {}).display_name || 'PayProTec', avatar: (pmap[p.author_id] || {}).avatar_url || null })) });
        }
        // Book-a-call config for the lead home (the calendar staff picked).
        if (action === 'lead_home_config') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const { data: s } = await supabase.from('app_settings').select('key, value').in('key', ['lead_portal_calendar_id']);
            const cid = ((s || []).find(r => r.key === 'lead_portal_calendar_id') || {}).value || '';
            return ok(res, { calendar_url: cid ? ('https://api.leadconnectorhq.com/widget/booking/' + cid) : '' });
        }

        // ══════════ STAFF (Lead Portal admin) actions ══════════
        const session = await validateSession(req);
        if (!session) return bad(res, 'Unauthorized', 401);
        const actor = await loadActor(session.userid);
        if (!canLeadPortal(actor)) return bad(res, 'Access denied. Lead Portal access required.', 403);
        const log = (fields) => logActivity({ email: actor.email || session.userid, category: 'marketing', ...fields }, req);

        if (action === 'can_access') return ok(res, { can_access: true });

        if (action === 'list_questions') {
            const { data } = await supabase.from('lead_onboarding_questions').select('*').order('sort_order').order('created_at');
            return ok(res, { questions: data || [] });
        }
        if (action === 'save_question') {
            const patch = {
                question: String(body.question || '').slice(0, 500),
                help_text: body.help_text ? String(body.help_text).slice(0, 500) : null,
                type: QTYPES.has(body.type) ? body.type : 'short_text',
                options: Array.isArray(body.options) ? body.options.map(o => String(o).slice(0, 200)).filter(Boolean).slice(0, 30) : [],
                required: !!body.required,
                is_active: body.is_active === undefined ? true : !!body.is_active
            };
            if (!patch.question) return bad(res, 'Question text required.');
            if (body.id) { await supabase.from('lead_onboarding_questions').update(patch).eq('id', body.id); log({ action: `${actorName(actor)} edited a lead onboarding question`, target_type: 'lead_question', target_id: body.id }); return ok(res, { id: body.id }); }
            const { data: maxRow } = await supabase.from('lead_onboarding_questions').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
            patch.sort_order = (maxRow?.sort_order || 0) + 1;
            const { data, error } = await supabase.from('lead_onboarding_questions').insert(patch).select('id').single();
            if (error) return bad(res, error.message);
            log({ action: `${actorName(actor)} added a lead onboarding question`, target_type: 'lead_question', target_id: data.id });
            return ok(res, { id: data.id });
        }
        if (action === 'delete_question') {
            await supabase.from('lead_onboarding_questions').delete().eq('id', body.id);
            log({ action: `${actorName(actor)} deleted a lead onboarding question`, severity: 'warning', target_type: 'lead_question', target_id: body.id });
            return ok(res, { deleted: true });
        }
        if (action === 'reorder_questions') {
            const ids = Array.isArray(body.ids) ? body.ids : [];
            for (let i = 0; i < ids.length; i++) await supabase.from('lead_onboarding_questions').update({ sort_order: i + 1 }).eq('id', ids[i]);
            return ok(res, {});
        }

        if (action === 'list_leads') {
            const { data: leads } = await supabase.from('leads').select('id, full_name, email, phone, status, onboarding_completed, assigned_rep, source, created_at, last_login').order('created_at', { ascending: false }).limit(50000);
            const total = (leads || []).length;
            const onboarded = (leads || []).filter(l => l.onboarding_completed).length;
            const converted = (leads || []).filter(l => l.status === 'converted').length;
            const stats = { total, onboarded, pending: total - onboarded, converted };
            return ok(res, { leads: leads || [], stats });
        }
        if (action === 'lead_detail') {
            const { data: lead } = await supabase.from('leads').select('*').eq('id', body.lead_id).maybeSingle();
            if (!lead) return bad(res, 'Lead not found', 404);
            delete lead.password_hash;
            const { data: qs } = await supabase.from('lead_onboarding_questions').select('id, question, type').order('sort_order');
            const { data: ans } = await supabase.from('lead_onboarding_answers').select('question_id, answer').eq('lead_id', body.lead_id);
            const amap = {}; (ans || []).forEach(a => { amap[a.question_id] = a.answer; });
            const answers = (qs || []).map(q => ({ question: q.question, type: q.type, answer: amap[q.id] ?? null })).filter(a => a.answer != null);
            return ok(res, { lead, answers });
        }

        // Lead Portal settings: pick the HighLevel calendar (PayProTec Partners) for book-a-call.
        if (action === 'get_lead_settings') {
            const locationId = (await getConfigValue('GHL_LOCATION_ID')) || process.env.GHL_LOCATION_ID;
            let calendars = [], locName = '';
            if (locationId) { try { calendars = await ghlListCalendars(locationId); const n = await ghlLocationNames([locationId]); locName = n[locationId] || ''; } catch (e) { /* ignore */ } }
            const { data: s } = await supabase.from('app_settings').select('key, value').in('key', ['lead_portal_calendar_id', 'lead_portal_calendar_name']);
            const map = {}; (s || []).forEach(r => { map[r.key] = r.value; });
            return ok(res, { configured: !!locationId, location_id: locationId || '', location_name: locName, calendars, calendar_id: map.lead_portal_calendar_id || '', calendar_name: map.lead_portal_calendar_name || '' });
        }
        if (action === 'save_lead_settings') {
            const cid = String(body.calendar_id || '').trim(), cname = String(body.calendar_name || '').trim();
            const now = new Date().toISOString();
            await supabase.from('app_settings').upsert({ key: 'lead_portal_calendar_id', value: cid, updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            await supabase.from('app_settings').upsert({ key: 'lead_portal_calendar_name', value: cname, updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            log({ action: `${actorName(actor)} set the Lead Portal book-a-call calendar${cname ? ' → ' + cname : ''}`, target_type: 'lead_setting', target_id: 'lead_portal_calendar_id' });
            return ok(res, {});
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
