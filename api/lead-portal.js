// ── Lead Portal API ─────────────────────────────────────────────────────────
// Two audiences:
//  • STAFF (Marketing → Lead Portal, gated by access_lead_portal): build the
//    onboarding survey + view leads/stats/answers.
//  • LEADS (prospective partners): self-register, log in, answer onboarding.
// Leads are isolated from persons/partner data until they graduate to partner.
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { sendLeadInvite } from './_lead-invite.js';
import { validateSession } from './_validate.js';
import { loadActor, actorName, canLeadPortal, canProspects, canDeleteLeads } from './_access.js';
import { logActivity } from './_activity.js';
import { getConfigValue } from './api-config.js';
import { issuePartnershipCerts } from './certificates.js';
import { ghlListCalendars, ghlLocationNames, ghlFindContactByEmail, ghlFindContactsByEmail, ghlContactAppointments, ghlSearchContactsByTag, ghlContactLink, ghlListUsers, ghlSetContactCustomFieldsByName, ghlSearchContacts } from './_ghl.js';

async function ghlLocId() { return (await getConfigValue('GHL_LOCATION_ID')) || process.env.GHL_LOCATION_ID || null; }
// The assigned rep's public summary (name + job level + bio + photo) for a lead.
async function repSummary(supabaseClient, userid) {
    if (!userid) return null;
    const { data: u } = await supabaseClient.from('app_users')
        .select('userid, first_name, last_name, email, rep_bio, rep_job_level, rep_photo_url, rep_milestones, rep_phone').eq('userid', userid).maybeSingle();
    if (!u) return null;
    // Single "actual photo" = the community profile avatar; fall back to the
    // legacy rep photo for any older records.
    const { data: prof } = await supabaseClient.from('user_profiles').select('avatar_url').eq('user_id', userid).maybeSingle();
    return {
        name: (`${u.first_name || ''} ${u.last_name || ''}`.trim()) || u.email || 'Your rep',
        job_level: u.rep_job_level || '', bio: u.rep_bio || '',
        email: u.email || '', phone: u.rep_phone || '',
        photo_url: (prof && prof.avatar_url) || u.rep_photo_url || '',
        milestones: Array.isArray(u.rep_milestones) ? u.rep_milestones : []
    };
}

// ── "Why Partner?" CMS content (estimator / unlock / FAQ / testimonials) ──────
const DEFAULT_ESTIMATOR = {
    rate: 0.004,
    label_merchants: 'How many merchants do you expect to sign?',
    label_volume: 'Average monthly processing per merchant',
    m_default: 20, m_max: 200,
    v_default: 40000, v_max: 200000, v_step: 5000,
    explanation: 'We estimate your monthly residual as: number of merchants × their average monthly processing volume × your residual rate. This is an illustration only — your actual rate depends on your rev-share and each merchant’s pricing, which your rep reviews on the call.'
};
async function getLeadContent(supabaseClient) {
    const { data } = await supabaseClient.from('app_settings').select('key, value')
        .in('key', ['lead_estimator', 'lead_estimator_rate', 'lead_unlock', 'lead_faq', 'lead_testimonials', 'lead_stats', 'lead_resources']);
    const m = {}; (data || []).forEach(r => { m[r.key] = r.value; });
    let est = {}; try { est = JSON.parse(m.lead_estimator || '{}') || {}; } catch (e) { est = {}; }
    const estimator = Object.assign({}, DEFAULT_ESTIMATOR, est);
    if (!est.rate && m.lead_estimator_rate) estimator.rate = Number(m.lead_estimator_rate) || estimator.rate;
    const arr = (k) => { try { const a = JSON.parse(m[k] || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
    return { estimator, unlock: arr('lead_unlock'), faq: arr('lead_faq'), testimonials: arr('lead_testimonials'), stats: arr('lead_stats'), resources: arr('lead_resources') };
}

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
                if (locationId) { const r = await ghlUpsertContact(locationId, { name: full_name, email, phone }, ['Prospect']); if (r?.id) await supabase.from('leads').update({ ghl_contact_id: r.id }).eq('id', lead.id); }
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
        // Invite setup: look up a lead by invite token (for the setup page).
        if (action === 'lead_setup_info') {
            const t = String(body.token || '');
            if (!t) return bad(res, 'Invalid link', 400);
            const { data: lead } = await supabase.from('leads').select('full_name, email').eq('invite_token', t).maybeSingle();
            if (!lead) return bad(res, 'This setup link is invalid or has already been used.', 404);
            return ok(res, { full_name: lead.full_name || '', email: lead.email || '' });
        }
        // Invite setup: set the password, consume the token, sign them in.
        if (action === 'lead_set_password') {
            const t = String(body.token || '');
            const password = String(body.password || '');
            if (!t) return bad(res, 'Invalid link', 400);
            if (password.length < 6) return bad(res, 'Password must be at least 6 characters.');
            const { data: lead } = await supabase.from('leads').select('id, full_name, email, onboarding_completed, status, password_hash').eq('invite_token', t).maybeSingle();
            if (!lead) return bad(res, 'This setup link is invalid or has already been used.', 404);
            if (lead.password_hash) { await supabase.from('leads').update({ invite_token: null }).eq('id', lead.id); return bad(res, 'This account is already set up — please sign in.', 409); }
            const password_hash = await bcrypt.hash(password, 12);
            await supabase.from('leads').update({ password_hash, invite_token: null, last_login: new Date().toISOString() }).eq('id', lead.id);
            const st = token();
            await supabase.from('lead_sessions').insert({ session_token: st, lead_id: lead.id, expires_at: new Date(Date.now() + 7 * 864e5).toISOString() });
            return ok(res, { token: st, lead: { id: lead.id, full_name: lead.full_name, email: lead.email, onboarding_completed: lead.onboarding_completed, status: lead.status } });
        }
        if (action === 'lead_validate') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const { data: lead } = await supabase.from('leads').select('id, full_name, email, phone, photo_url, onboarding_completed, status, assigned_rep').eq('id', leadId).maybeSingle();
            return ok(res, { lead });
        }
        // Signed upload URL for a prospect's own photo (Supabase 'marketing' bucket).
        if (action === 'lead_upload_url') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };
            const ext = EXT[String(body.file_type || '')];
            if (!ext) return bad(res, 'Only PNG, JPG or WEBP images are allowed.');
            const path = `lead-photos/${leadId}_${Date.now()}.${ext}`;
            const { data, error } = await supabase.storage.from('marketing').createSignedUploadUrl(path);
            if (error) return bad(res, error.message, 500);
            const public_url = `${process.env.SUPABASE_URL}/storage/v1/object/public/marketing/${path}`;
            return ok(res, { upload_url: data.signedUrl, public_url });
        }
        if (action === 'lead_set_photo') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            await supabase.from('leads').update({ photo_url: (body.photo_url || '').toString().slice(0, 1000) || null }).eq('id', leadId);
            return ok(res, {});
        }
        if (action === 'lead_change_password') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const cur = String(body.current_password || ''), nw = String(body.new_password || '');
            if (nw.length < 6) return bad(res, 'New password must be at least 6 characters.');
            const { data: lead } = await supabase.from('leads').select('id, password_hash').eq('id', leadId).maybeSingle();
            if (!lead) return bad(res, 'Session expired', 401);
            if (lead.password_hash && !(await bcrypt.compare(cur, lead.password_hash))) return bad(res, 'Your current password is incorrect.');
            const hash = await bcrypt.hash(nw, 12);
            await supabase.from('leads').update({ password_hash: hash }).eq('id', leadId);
            return ok(res, {});
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
                .eq('is_published', true).eq('lead_visible', true).order('sort_order').order('created_at');
            const ids = (courses || []).map(c => c.id);
            let vids = [];
            if (ids.length) {
                const { data } = await supabase.from('course_videos').select('id, course_id, title, description, provider, url, thumbnail_url, available_on, ai_goal, ai_cta_link, ai_cta_label')
                    .in('course_id', ids).order('available_on', { ascending: false, nullsFirst: false }).order('sort_order').limit(50000);
                vids = data || [];
            }
            const now = Date.now();
            const byCourse = {};
            vids.forEach(v => {
                const avail = !v.available_on || new Date(v.available_on + 'T00:00:00').getTime() <= now;
                (byCourse[v.course_id] = byCourse[v.course_id] || []).push({ id: v.id, title: v.title, description: v.description, provider: v.provider, url: avail ? v.url : null, available: avail, unlock_at: avail ? null : v.available_on, thumbnail_url: v.thumbnail_url, cta_url: (avail && v.ai_goal && v.ai_goal !== 'none') ? (v.ai_cta_link || null) : null, cta_label: v.ai_cta_label || (v.ai_goal === 'signup' ? 'Sign up' : 'Book an appointment') });
            });
            return ok(res, { courses: (courses || []).map(c => ({ ...c, videos: byCourse[c.id] || [] })) });
        }
        // Record a prospect (lead) video view → course_video_views (feeds the
        // same per-video portal-view stats staff see in Marketing → Courses).
        if (action === 'lead_log_view') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            if (!body.video_id) return bad(res, 'video_id required');
            const { data: vid } = await supabase.from('course_videos').select('id, course_id').eq('id', body.video_id).maybeSingle();
            if (!vid) return bad(res, 'Video not found', 404);
            await supabase.from('course_video_views').insert({ video_id: vid.id, course_id: vid.course_id, lead_id: leadId });
            return ok(res, {});
        }
        // Announcement board for leads (read-only) — from Marketing → Campaigns
        // that have "Show on Lead Portal" enabled and are currently active.
        if (action === 'lead_announcements') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const nowIso = new Date().toISOString();
            const { data: camps } = await supabase.from('marketing_campaigns')
                .select('id, title, body_text, image_url, cta_enabled, cta_label, cta_url, starts_at, ends_at, priority, created_at')
                .in('audience', ['prospect', 'all']).eq('is_active', true)
                .order('priority', { ascending: false }).order('created_at', { ascending: false }).limit(50);
            const live = (camps || []).filter(c =>
                (!c.starts_at || c.starts_at <= nowIso) && (!c.ends_at || c.ends_at >= nowIso));
            return ok(res, {
                announcements: live.map(c => ({
                    id: c.id,
                    title: c.title,
                    body: c.body_text,
                    image_url: c.image_url,
                    cta_label: c.cta_enabled ? c.cta_label : null,
                    cta_url: c.cta_enabled ? c.cta_url : null,
                    created_at: c.created_at,
                    author: 'PayProTec',
                    avatar: null
                }))
            });
        }
        // Record a lead's view/click of a campaign announcement → marketing_events
        // (so Marketing → Campaign Stats counts the Lead Portal channel).
        if (action === 'lead_track') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const evt = body.event_type;
            if (!body.campaign_id || !['impression', 'click'].includes(evt)) return ok(res, { logged: false });
            // De-dupe impressions: one per lead per campaign per ~20h.
            if (evt === 'impression') {
                const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
                const { data: recent } = await supabase.from('marketing_events').select('id')
                    .eq('campaign_id', body.campaign_id).eq('user_id', leadId).eq('event_type', 'impression')
                    .gte('created_at', since).limit(1);
                if (recent && recent.length) return ok(res, { logged: false });
            }
            await supabase.from('marketing_events').insert({
                campaign_id: body.campaign_id, user_id: leadId, user_type: 'lead',
                event_type: evt, target: evt === 'click' ? 'cta' : null
            });
            return ok(res, { logged: true });
        }
        // Book-a-call config for the lead home (the calendar staff picked).
        if (action === 'lead_home_config') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const { data: s } = await supabase.from('app_settings').select('key, value').in('key', ['lead_portal_calendar_id']);
            const cid = ((s || []).find(r => r.key === 'lead_portal_calendar_id') || {}).value || '';
            const content = await getLeadContent(supabase);
            let calendarUrl = '';
            if (cid) {
                calendarUrl = 'https://api.leadconnectorhq.com/widget/booking/' + cid;
                // Prefill the booking form from the signed-in prospect's record
                // (their contact is already tunneled to HighLevel).
                const { data: lead } = await supabase.from('leads').select('full_name, email, phone').eq('id', leadId).maybeSingle();
                if (lead) {
                    const parts = String(lead.full_name || '').trim().split(/\s+/);
                    const first = parts.shift() || '';
                    const last = parts.join(' ');
                    const q = new URLSearchParams();
                    if (first) q.set('first_name', first);
                    if (last) q.set('last_name', last);
                    if (lead.email) q.set('email', lead.email);
                    if (lead.phone) q.set('phone', lead.phone);
                    const qs = q.toString();
                    if (qs) calendarUrl += '?' + qs;
                }
            }
            return ok(res, { calendar_url: calendarUrl, estimator: content.estimator, unlock: content.unlock, faq: content.faq, testimonials: content.testimonials, stats: content.stats, resources: content.resources });
        }

        // Lead home extras: their upcoming appointment (from HighLevel) + the
        // assigned rep's profile summary.
        if (action === 'lead_my_appointment') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            const { data: lead } = await supabase.from('leads').select('ghl_contact_id, email, assigned_rep').eq('id', leadId).maybeSingle();
            let upcoming = null, past = [];
            const diag = { configured: false, contactId: '', count: 0, err: '' };
            if (lead) {
                try {
                    const locationId = await ghlLocId();
                    diag.configured = !!locationId;
                    // Gather every HighLevel contact for this email (bookings can
                    // land on a duplicate contact), plus the stored id, then merge
                    // all their appointments and de-dupe.
                    const contactIds = new Set();
                    if (lead.ghl_contact_id) contactIds.add(lead.ghl_contact_id);
                    if (locationId && lead.email) {
                        const matches = await ghlFindContactsByEmail(locationId, lead.email);
                        matches.forEach(m => { if (m.id) contactIds.add(m.id); });
                    }
                    let appts = [];
                    for (const cid of contactIds) {
                        const a = await ghlContactAppointments(locationId, cid);
                        if (a && a.length) appts.push(...a);
                    }
                    // De-dupe by appointment id.
                    const seen = new Set();
                    appts = appts.filter(a => a && a.id && !seen.has(a.id) && seen.add(a.id));
                    // Keep the lead's stored contact pointed at one that has bookings.
                    const withAppt = [...contactIds].find(Boolean);
                    if (withAppt && withAppt !== lead.ghl_contact_id) await supabase.from('leads').update({ ghl_contact_id: withAppt }).eq('id', leadId);
                    diag.contactId = [...contactIds].join(','); diag.count = appts.length;
                    // Format times in the business timezone so they read correctly
                    // regardless of the viewer's browser timezone.
                    const { data: bp } = await supabase.from('business_profile').select('timezone').eq('id', 1).maybeSingle();
                    const tz = (bp && bp.timezone) || 'America/New_York';
                    const label = iso => { try { return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(new Date(iso)); } catch (e) { return ''; } };
                    appts.forEach(a => { a.when_label = label(a.start); });
                    const now = Date.now();
                    const cancelled = a => /cancel|no.?show|invalid|delete/i.test(a.status || '');
                    const endMs = a => new Date(a.end || a.start).getTime();
                    // Upcoming = next non-cancelled appointment whose END is still ahead
                    // (so an in-progress / same-day meeting stays "upcoming").
                    upcoming = appts.filter(a => !cancelled(a)).find(a => endMs(a) >= now) || null;
                    // Past = cancelled, or already finished (most recent first).
                    past = appts.filter(a => cancelled(a) || endMs(a) < now)
                        .sort((a, b) => new Date(b.start) - new Date(a.start));
                } catch (e) { diag.err = e.message || 'error'; }
            }
            // Resolve the assigned rep. A manually-assigned rep wins; otherwise
            // derive it from who an appointment is booked with (its HighLevel user
            // → the app user mapped in User Management), preferring the upcoming
            // one, else the most recent appointment. Backfill onto the lead so the
            // lead list shows it too. The rep shows regardless of whether the
            // appointment is upcoming or already done.
            let repUserid = lead && lead.assigned_rep;
            const apptForRep = upcoming || past[0] || null;
            if (!repUserid && apptForRep && apptForRep.assigned_user_id) {
                const { data: mapped } = await supabase.from('app_users').select('userid').eq('ghl_user_id', apptForRep.assigned_user_id).maybeSingle();
                if (mapped) { repUserid = mapped.userid; await supabase.from('leads').update({ assigned_rep: repUserid }).eq('id', leadId); }
            }
            let rep = await repSummary(supabase, repUserid);
            // Fallback: HighLevel user isn't mapped to an app profile yet — show at
            // least who the appointment is with (name + photo) from HighLevel.
            if (!rep && apptForRep && apptForRep.assigned_user_id) {
                try {
                    const hlUsers = await ghlListUsers(await ghlLocId());
                    const hu = hlUsers.find(u => u.id === apptForRep.assigned_user_id);
                    if (hu) rep = { name: hu.name || 'Your rep', job_level: hu.role || '', bio: '', email: hu.email || '', phone: hu.phone || '', photo_url: hu.photo || '', milestones: [] };
                } catch (e) { /* best-effort */ }
            }
            // Journey progress signals for the home milestones.
            const { data: lp } = await supabase.from('leads').select('video_watch_seconds').eq('id', leadId).maybeSingle();
            const watch_seconds = (lp && lp.video_watch_seconds) || 0;
            const has_appointment = !!(upcoming || (past && past.length));
            return ok(res, { upcoming, past, rep, watch_seconds, has_appointment, _diag: diag });
        }
        // Accumulate a prospect's total video watch time (drives the
        // "Explore & Learn" milestone; ~10 min = complete).
        if (action === 'lead_add_watch') {
            const leadId = await validateLead(body.token);
            if (!leadId) return bad(res, 'Session expired', 401);
            let inc = parseInt(body.seconds, 10); if (!Number.isFinite(inc) || inc < 0) inc = 0;
            inc = Math.min(inc, 600); // guard against bogus large jumps per call
            const { data: cur } = await supabase.from('leads').select('video_watch_seconds').eq('id', leadId).maybeSingle();
            const total = ((cur && cur.video_watch_seconds) || 0) + inc;
            await supabase.from('leads').update({ video_watch_seconds: total }).eq('id', leadId);
            return ok(res, { watch_seconds: total });
        }

        // ══════════ STAFF actions ══════════
        const session = await validateSession(req);
        if (!session) return bad(res, 'Unauthorized', 401);
        const actor = await loadActor(session.userid);
        if (!actor || actor.is_active === false) return bad(res, 'Unauthorized', 401);
        const canLP = canLeadPortal(actor);
        const log = (fields) => logActivity({ email: actor.email || session.userid, category: 'marketing', ...fields }, req);
        // Prospects page (view + assign) requires the Prospects permission (or
        // Lead Portal / admin). Survey/settings/import still require Lead Portal.
        const STAFF_ACTIONS = new Set(['list_leads', 'count_new_leads', 'lead_detail', 'list_reps', 'set_lead_rep', 'graduate_lead', 'send_lead_invite', 'create_lead_from_ghl', 'ghl_contact_search', 'content_upload_url']);
        if (action === 'delete_lead') {
            if (!canDeleteLeads(actor)) return bad(res, 'Access denied. Delete Leads access required.', 403);
        } else if (STAFF_ACTIONS.has(action)) {
            if (!canProspects(actor)) return bad(res, 'Access denied. Prospects access required.', 403);
        } else if (!canLP) {
            return bad(res, 'Access denied. Lead Portal access required.', 403);
        }

        // Delete a prospect and revoke their Lead Portal access (kills sessions).
        if (action === 'delete_lead') {
            if (!body.lead_id) return bad(res, 'lead_id required');
            const { data: lead } = await supabase.from('leads').select('id, full_name, email').eq('id', body.lead_id).maybeSingle();
            if (!lead) return bad(res, 'Lead not found', 404);
            // Revoke access + clear dependent rows, then delete the lead.
            await supabase.from('lead_sessions').delete().eq('lead_id', lead.id);
            await supabase.from('lead_onboarding_answers').delete().eq('lead_id', lead.id);
            try { await supabase.from('course_video_views').delete().eq('lead_id', lead.id); } catch (e) { /* cascade may handle it */ }
            const { error } = await supabase.from('leads').delete().eq('id', lead.id);
            if (error) return bad(res, error.message);
            log({ action: `${actorName(actor)} deleted prospect "${lead.full_name || lead.email || lead.id}" and revoked portal access`, severity: 'warning', target_type: 'lead', target_id: lead.id });
            return ok(res, { deleted: true });
        }

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
        if (action === 'count_new_leads') {
            // New (unhandled) prospects — drives the noticeable nav badge.
            const { count } = await supabase.from('leads').select('id', { count: 'exact', head: true }).eq('status', 'new');
            return ok(res, { count: count || 0 });
        }
        if (action === 'lead_detail') {
            const { data: lead } = await supabase.from('leads').select('*').eq('id', body.lead_id).maybeSingle();
            if (!lead) return bad(res, 'Lead not found', 404);
            const activated = !!lead.password_hash;   // has set a password = active portal account
            delete lead.password_hash;
            const { data: qs } = await supabase.from('lead_onboarding_questions').select('id, question, type').order('sort_order');
            const { data: ans } = await supabase.from('lead_onboarding_answers').select('question_id, answer').eq('lead_id', body.lead_id);
            const amap = {}; (ans || []).forEach(a => { amap[a.question_id] = a.answer; });
            const answers = (qs || []).map(q => ({ question: q.question, type: q.type, answer: amap[q.id] ?? null })).filter(a => a.answer != null);
            // ── HighLevel lookup by contact id or email + appointments ──
            let ghl = null, appointments = [], ghlLink = '';
            try {
                const locationId = await ghlLocId();
                if (locationId) {
                    let contactId = lead.ghl_contact_id;
                    if (!contactId && lead.email) {
                        const found = await ghlFindContactByEmail(locationId, lead.email);
                        if (found) { contactId = found.id; ghl = found; if (contactId) await supabase.from('leads').update({ ghl_contact_id: contactId }).eq('id', lead.id); }
                    } else if (contactId && lead.email) {
                        ghl = await ghlFindContactByEmail(locationId, lead.email);
                    }
                    if (contactId) {
                        appointments = await ghlContactAppointments(locationId, contactId);
                        ghlLink = ghlContactLink(locationId, contactId);
                    }
                    // Mirror (fill-only-empty) from HighLevel back onto the lead record.
                    if (ghl) {
                        const patch = {};
                        if (!lead.phone && ghl.phone) patch.phone = ghl.phone;
                        if (!lead.full_name && ghl.name) patch.full_name = ghl.name;
                        if (Object.keys(patch).length) { await supabase.from('leads').update(patch).eq('id', lead.id); Object.assign(lead, patch); }
                    }
                }
            } catch (e) { /* best-effort */ }
            // Auto-resolve the assigned rep from the appointment's HighLevel user
            // via the User Management mapping, and backfill (same as the lead home).
            let repUid = lead.assigned_rep;
            if (!repUid) {
                const src = (appointments || []).find(a => a.assigned_user_id) || null;
                if (src) {
                    const { data: mapped } = await supabase.from('app_users').select('userid').eq('ghl_user_id', src.assigned_user_id).maybeSingle();
                    if (mapped) { repUid = mapped.userid; await supabase.from('leads').update({ assigned_rep: repUid }).eq('id', lead.id); lead.assigned_rep = repUid; }
                }
            }
            const rep = await repSummary(supabase, repUid);
            return ok(res, { lead, answers, ghl, appointments, rep, ghl_link: ghlLink, activated });
        }
        // Staff list for the "assign rep" picker.
        if (action === 'list_reps') {
            const { data: reps } = await supabase.from('app_users')
                .select('userid, first_name, last_name, email, role, is_active, rep_job_level').eq('is_active', true).order('first_name');
            return ok(res, { reps: (reps || []).map(u => ({ userid: u.userid, name: (`${u.first_name || ''} ${u.last_name || ''}`.trim()) || u.email, role: u.role || '', job_level: u.rep_job_level || '' })) });
        }
        // Graduate a prospect → partner: write the agent IDs + rev share to the
        // HighLevel contact's custom fields ("Rep Code" / "Prime49ID") and mark
        // the lead converted. (The partner record itself is created by the normal
        // partner-onboarding flow; this finalizes the HighLevel + status side.)
        if (action === 'graduate_lead') {
            if (!body.lead_id) return bad(res, 'lead_id required');
            const { data: lead } = await supabase.from('leads').select('id, ghl_contact_id, email, full_name, photo_url').eq('id', body.lead_id).maybeSingle();
            if (!lead) return bad(res, 'Lead not found', 404);
            const ids = Array.isArray(body.identifiers) ? body.identifiers : [];
            // "34893(50%) | 24387(70%)"
            const repCode = ids.map(i => `${String(i.string || '').trim()}(${String(i.rev || '0%')})`).filter(function (s) { return s && s[0] !== '('; }).join(' | ');
            const primeId = (ids.find(i => i.prime) || {}).string || '';
            const locationId = await ghlLocId();
            let contactId = lead.ghl_contact_id;
            if (!contactId && locationId && lead.email) {
                const f = await ghlFindContactByEmail(locationId, lead.email);
                if (f && f.id) { contactId = f.id; await supabase.from('leads').update({ ghl_contact_id: contactId }).eq('id', lead.id); }
            }
            let ghlResult = { ok: false, error: 'not attempted' };
            if (locationId && contactId) {
                const map = {};
                if (repCode) map['Rep Code'] = repCode;
                if (primeId) map['Prime49ID'] = primeId;
                if (Object.keys(map).length) { try { ghlResult = await ghlSetContactCustomFieldsByName(locationId, contactId, map); } catch (e) { ghlResult = { ok: false, error: e.message }; } }
            }
            // Link the newly-created partner person (matched by hl_contact_id).
            let personId = null, personName = null;
            if (contactId) { const { data: p } = await supabase.from('persons').select('id, full_name').eq('hl_contact_id', contactId).maybeSingle(); if (p) { personId = p.id; personName = p.full_name; } }
            // Carry the prospect's profile photo over to the partner side (community/partner
            // portal reads user_profiles.avatar_url, not leads.photo_url). Fill-only-empty:
            // never clobber an avatar the partner may already have set.
            if (personId && lead.photo_url) {
                try {
                    const { data: prof } = await supabase.from('user_profiles').select('avatar_url').eq('user_id', personId).maybeSingle();
                    if (!prof || !prof.avatar_url) {
                        await supabase.from('user_profiles').upsert(
                            { user_id: personId, user_type: 'partner', display_name: personName || lead.full_name || '', avatar_url: lead.photo_url },
                            { onConflict: 'user_id' });
                    }
                } catch (e) { /* best-effort — graduation must still succeed */ }
            }
            await supabase.from('leads').update({ status: 'converted', converted_person_id: personId }).eq('id', lead.id);
            // Auto-issue the partnership certificate(s) — one per company (best-effort).
            let certificate = null;
            if (personId) {
                try {
                    const list = await issuePartnershipCerts(supabase, personId, { recipientName: personName || lead.full_name, source: 'graduation' });
                    if (Array.isArray(list) && list.length) certificate = list.length;
                } catch (e) { /* certificate is a bonus — graduation still succeeds */ }
            }
            log({ action: `${actorName(actor)} graduated a prospect to partner${repCode ? ' — ' + repCode : ''}`, target_type: 'lead', target_id: lead.id });
            return ok(res, { converted: true, person_id: personId, rep_code: repCode, prime49_id: primeId, ghl: ghlResult, certificate });
        }
        // Signed upload URL for testimonial/content photos (Supabase 'marketing' bucket).
        if (action === 'content_upload_url') {
            const ft = String(body.file_type || '');
            const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
            const ext = EXT[ft];
            if (!ext) return bad(res, 'Only PNG, JPG, WEBP or GIF images are allowed.');
            const path = `lead-content/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;
            const { data, error } = await supabase.storage.from('marketing').createSignedUploadUrl(path);
            if (error) return bad(res, error.message, 500);
            const public_url = `${process.env.SUPABASE_URL}/storage/v1/object/public/marketing/${path}`;
            return ok(res, { upload_url: data.signedUrl, public_url, path });
        }
        // Typeahead search of HighLevel contacts (name / email / phone / company / id).
        if (action === 'ghl_contact_search') {
            const q = String(body.query || '').trim();
            if (q.length < 2) return ok(res, { contacts: [] });
            const locationId = await ghlLocId();
            if (!locationId) return ok(res, { contacts: [], error: 'GHL_LOCATION_ID not configured' });
            let contacts = [];
            try { contacts = await ghlSearchContacts(locationId, q, 10); } catch (e) { /* best-effort */ }
            return ok(res, { contacts });
        }
        // Look up a HighLevel contact by email (or use a picked contact) and create a prospect.
        if (action === 'create_lead_from_ghl') {
            // A contact picked from the typeahead comes through as body.contact.
            const picked = (body.contact && typeof body.contact === 'object') ? body.contact : null;
            const email = String((picked && picked.email) || body.email || '').toLowerCase().trim();
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad(res, 'A valid email is required (the contact must have an email).');
            const locationId = await ghlLocId();
            let found = picked;
            if (!found && locationId) { try { found = await ghlFindContactByEmail(locationId, email); } catch (e) { /* best-effort */ } }
            const name = (found && found.name) || String(body.name || '').trim() || email;
            const phone = (found && found.phone) || '';
            const contactId = (found && (found.id || found.contact_id)) || null;
            const { data: existing } = await supabase.from('leads').select('id, password_hash, ghl_contact_id, phone, full_name').eq('email', email).maybeSingle();
            if (existing) {
                const patch = {};
                if (!existing.ghl_contact_id && contactId) patch.ghl_contact_id = contactId;
                if (!existing.phone && phone) patch.phone = phone;
                if (!existing.full_name && name) patch.full_name = name;
                if (Object.keys(patch).length) await supabase.from('leads').update(patch).eq('id', existing.id);
                let invited = false;
                if (body.invite && !existing.password_hash) invited = await sendLeadInvite(supabase, { id: existing.id, full_name: patch.full_name || existing.full_name || name, email }, req.headers.host);
                log({ action: `${actorName(actor)} linked an existing prospect from HighLevel (${email})`, target_type: 'lead', target_id: existing.id });
                return ok(res, { created: false, updated: true, ghl_found: !!found, invited });
            }
            const { data: newLead, error } = await supabase.from('leads').insert({
                email, full_name: name, phone, ghl_contact_id: contactId,
                source: found ? 'ghl-lookup' : 'manual', status: 'new', onboarding_completed: false
            }).select('id, full_name, email').single();
            if (error) return bad(res, error.message);
            let invited = false;
            if (body.invite && newLead) invited = await sendLeadInvite(supabase, newLead, req.headers.host);
            log({ action: `${actorName(actor)} created a prospect from HighLevel (${email})`, target_type: 'lead', target_id: newLead.id });
            return ok(res, { created: true, ghl_found: !!found, invited });
        }
        // Manually send a prospect their account-setup invite email.
        if (action === 'send_lead_invite') {
            if (!body.lead_id) return bad(res, 'lead_id required');
            const { data: lead } = await supabase.from('leads').select('id, full_name, email, password_hash').eq('id', body.lead_id).maybeSingle();
            if (!lead) return bad(res, 'Lead not found', 404);
            if (!lead.email) return bad(res, 'This prospect has no email.');
            if (lead.password_hash) return bad(res, 'This prospect already has an active account — no setup invite needed.');
            const sent = await sendLeadInvite(supabase, lead, req.headers.host);
            log({ action: `${actorName(actor)} sent a setup invite to prospect ${lead.email}`, target_type: 'lead', target_id: lead.id });
            return ok(res, { sent });
        }
        // Assign / unassign a rep to a lead ("tunnel" the lead to a person).
        if (action === 'set_lead_rep') {
            if (!body.lead_id) return bad(res, 'lead_id required');
            await supabase.from('leads').update({ assigned_rep: body.rep_userid || null }).eq('id', body.lead_id);
            log({ action: `${actorName(actor)} assigned a rep to a lead`, target_type: 'lead', target_id: body.lead_id });
            return ok(res, { rep: await repSummary(supabase, body.rep_userid) });
        }
        // Import HighLevel lead-gen contacts (by tag) as prospect accounts.
        if (action === 'import_ghl_leads') {
            const locationId = await ghlLocId();
            if (!locationId) return bad(res, 'GHL_LOCATION_ID is not configured.');
            const { data: s } = await supabase.from('app_settings').select('value').eq('key', 'lead_import_tag').maybeSingle();
            const tag = String((body.tag || s?.value || '').trim());
            if (!tag) return bad(res, 'Set an import tag first (Lead Portal → Settings).');
            let contacts = [], diag = { method: '', scanned: 0, error: '' };
            try { const rr = await ghlSearchContactsByTag(locationId, tag, 200); contacts = rr.contacts || []; diag = { method: rr.method, scanned: rr.scanned, error: rr.error || '' }; } catch (e) { return bad(res, 'HighLevel lookup failed: ' + (e.message || 'error')); }
            // Auto-invite toggle: email new prospects a setup link on import.
            const { data: inv } = await supabase.from('app_settings').select('value').eq('key', 'lead_import_auto_invite').maybeSingle();
            const autoInvite = String(inv?.value || '') === 'true';
            let created = 0, updated = 0, skipped = 0, invited = 0;
            for (const c of contacts) {
                const email = String(c.email || '').toLowerCase().trim();
                if (!email) { skipped++; continue; }
                const { data: existing } = await supabase.from('leads').select('id, full_name, phone, ghl_contact_id').eq('email', email).maybeSingle();
                if (existing) {
                    // Fill-only-empty enrichment on the existing lead.
                    const patch = {};
                    if (!existing.ghl_contact_id && c.id) patch.ghl_contact_id = c.id;
                    if (!existing.phone && c.phone) patch.phone = c.phone;
                    if (!existing.full_name && c.name) patch.full_name = c.name;
                    if (Object.keys(patch).length) { await supabase.from('leads').update(patch).eq('id', existing.id); updated++; } else { skipped++; }
                    continue;
                }
                const { data: newLead, error } = await supabase.from('leads').insert({
                    email, full_name: c.name || email, phone: c.phone || '',
                    ghl_contact_id: c.id || null, source: 'highlevel:' + tag, status: 'new', onboarding_completed: false
                }).select('id, full_name, email').single();
                if (error) { skipped++; } else {
                    created++;
                    if (autoInvite) { try { if (await sendLeadInvite(supabase, newLead, req.headers.host)) invited++; } catch (e) { /* best-effort */ } }
                }
            }
            log({ action: `${actorName(actor)} synced HighLevel leads (tag "${tag}"): ${created} new, ${updated} enriched${autoInvite ? ', ' + invited + ' invited' : ''}`, target_type: 'lead', target_id: 'import' });
            return ok(res, { created, updated, skipped, invited, auto_invite: autoInvite, total: contacts.length, tag, diag });
        }

        // Lead Portal settings: pick the HighLevel calendar (PayProTec Partners) for book-a-call.
        if (action === 'get_lead_settings') {
            const locationId = (await getConfigValue('GHL_LOCATION_ID')) || process.env.GHL_LOCATION_ID;
            let calendars = [], locName = '';
            if (locationId) { try { calendars = await ghlListCalendars(locationId); const n = await ghlLocationNames([locationId]); locName = n[locationId] || ''; } catch (e) { /* ignore */ } }
            const { data: s } = await supabase.from('app_settings').select('key, value').in('key', ['lead_portal_calendar_id', 'lead_portal_calendar_name', 'lead_import_tag', 'lead_import_auto_invite']);
            const map = {}; (s || []).forEach(r => { map[r.key] = r.value; });
            const content = await getLeadContent(supabase);
            return ok(res, { configured: !!locationId, location_id: locationId || '', location_name: locName, calendars, calendar_id: map.lead_portal_calendar_id || '', calendar_name: map.lead_portal_calendar_name || '', import_tag: map.lead_import_tag || '', auto_invite: map.lead_import_auto_invite === 'true', webhook_secret_set: !!process.env.LEAD_WEBHOOK_SECRET, estimator: content.estimator, unlock: content.unlock, faq: content.faq, testimonials: content.testimonials, stats: content.stats, resources: content.resources });
        }
        if (action === 'save_lead_settings') {
            const cid = String(body.calendar_id || '').trim(), cname = String(body.calendar_name || '').trim();
            const now = new Date().toISOString();
            await supabase.from('app_settings').upsert({ key: 'lead_portal_calendar_id', value: cid, updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            await supabase.from('app_settings').upsert({ key: 'lead_portal_calendar_name', value: cname, updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            if (body.import_tag !== undefined) await supabase.from('app_settings').upsert({ key: 'lead_import_tag', value: String(body.import_tag || '').trim(), updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            if (body.auto_invite !== undefined) await supabase.from('app_settings').upsert({ key: 'lead_import_auto_invite', value: body.auto_invite ? 'true' : 'false', updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            if (body.testimonials !== undefined) {
                const clean = (Array.isArray(body.testimonials) ? body.testimonials : [])
                    .map(t => ({
                        photo_url: String(t.photo_url || '').slice(0, 1000),
                        name: String(t.name || '').slice(0, 120),
                        company: String(t.company || '').slice(0, 160),
                        earnings: String(t.earnings || '').slice(0, 60),
                        description: String(t.description || '').slice(0, 200),
                        quote: String(t.quote || '').slice(0, 600),
                        story: String(t.story || '').slice(0, 4000)
                    }))
                    .filter(t => t.quote || t.story || t.name).slice(0, 60);
                await supabase.from('app_settings').upsert({ key: 'lead_testimonials', value: JSON.stringify(clean), updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            }
            if (body.unlock !== undefined) {
                const clean = (Array.isArray(body.unlock) ? body.unlock : [])
                    .map(u => ({ icon: String(u.icon || 'check_circle').slice(0, 40), title: String(u.title || '').slice(0, 120), desc: String(u.desc || '').slice(0, 300) }))
                    .filter(u => u.title).slice(0, 30);
                await supabase.from('app_settings').upsert({ key: 'lead_unlock', value: JSON.stringify(clean), updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            }
            if (body.faq !== undefined) {
                const clean = (Array.isArray(body.faq) ? body.faq : [])
                    .map(f => ({ q: String(f.q || '').slice(0, 240), a: String(f.a || '').slice(0, 2000) }))
                    .filter(f => f.q).slice(0, 40);
                await supabase.from('app_settings').upsert({ key: 'lead_faq', value: JSON.stringify(clean), updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            }
            if (body.stats !== undefined) {
                const clean = (Array.isArray(body.stats) ? body.stats : [])
                    .map(s2 => ({ value: String(s2.value || '').slice(0, 40), label: String(s2.label || '').slice(0, 80) }))
                    .filter(s2 => s2.value).slice(0, 8);
                await supabase.from('app_settings').upsert({ key: 'lead_stats', value: JSON.stringify(clean), updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            }
            if (body.resources !== undefined) {
                const clean = (Array.isArray(body.resources) ? body.resources : [])
                    .map(rr => ({ title: String(rr.title || '').slice(0, 160), description: String(rr.description || '').slice(0, 300), url: String(rr.url || '').slice(0, 1000), icon: String(rr.icon || 'description').slice(0, 40) }))
                    .filter(rr => rr.title && rr.url).slice(0, 40);
                await supabase.from('app_settings').upsert({ key: 'lead_resources', value: JSON.stringify(clean), updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            }
            if (body.estimator !== undefined && typeof body.estimator === 'object') {
                const e = body.estimator;
                let rt = Number(e.rate); if (!Number.isFinite(rt) || rt <= 0) rt = 0.004; rt = Math.min(0.05, rt);
                const clean = {
                    rate: rt,
                    label_merchants: String(e.label_merchants || DEFAULT_ESTIMATOR.label_merchants).slice(0, 160),
                    label_volume: String(e.label_volume || DEFAULT_ESTIMATOR.label_volume).slice(0, 160),
                    m_default: Math.max(1, Math.min(100000, Math.round(Number(e.m_default) || 20))),
                    m_max: Math.max(1, Math.min(100000, Math.round(Number(e.m_max) || 200))),
                    v_default: Math.max(0, Math.round(Number(e.v_default) || 40000)),
                    v_max: Math.max(1000, Math.round(Number(e.v_max) || 200000)),
                    v_step: Math.max(100, Math.round(Number(e.v_step) || 5000)),
                    explanation: String(e.explanation || DEFAULT_ESTIMATOR.explanation).slice(0, 2000)
                };
                await supabase.from('app_settings').upsert({ key: 'lead_estimator', value: JSON.stringify(clean), updated_at: now, updated_by: actorName(actor) }, { onConflict: 'key' });
            }
            log({ action: `${actorName(actor)} updated Lead Portal settings`, target_type: 'lead_setting', target_id: 'lead_portal_calendar_id' });
            return ok(res, {});
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
