// ── MARKETING / ANNOUNCEMENTS ────────────────────────────────────────────────
// Campaign announcements shown on the partner (and optionally staff) homepage,
// with graphic/text/both, a CTA button + clickable hotspots on the graphic,
// per-user "don't show again", activation/expiration windows, and full-funnel
// stats (impressions / clicks / dismissals) per campaign.
//
// Auth:
//   • Admin actions (manage campaigns, stats, upload) → staff session + the
//     access_marketing permission (super_admin / admin always allowed).
//   • Viewer actions (get_active / track / dismiss) → either a partner token
//     (partner_token in body) or a staff session. Mobile reuses the same JSON.

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { validateSession as validateStaff, sessionErrorResponse } from './_validate.js';
import { ghlListLocations, ghlLocationNames, ghlListForms, ghlListCalendars, ghlFormSubmissions, ghlCalendarAppointments } from './_ghl.js';
import { setConfigValue } from './api-config.js';
import * as webflow from './_webflow.js';

// Sanitize rich-text campaign bodies (WYSIWYG). Renders on partners' external
// sites, so this is the authoritative XSS boundary — allowlist only. The
// sanitizer is loaded lazily with a fallback so a missing/failed dependency can
// never take down the whole marketing API.
let _sanitizer = null, _sanitizerTried = false;
async function getSanitizer() {
    if (_sanitizerTried) return _sanitizer;
    _sanitizerTried = true;
    try { const m = await import('sanitize-html'); _sanitizer = m.default || m; } catch { _sanitizer = null; }
    return _sanitizer;
}
async function sanitizeBody(html) {
    if (html == null) return null;
    const s = await getSanitizer();
    if (s) {
        return s(String(html), {
            allowedTags: ['p', 'br', 'span', 'div', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'a',
                'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'sub', 'sup', 'pre', 'code', 'hr'],
            allowedAttributes: { a: ['href', 'target', 'rel'], '*': ['style', 'class'] },
            allowedSchemes: ['http', 'https', 'mailto', 'tel'],
            allowedStyles: {
                '*': {
                    'color': [/^.*$/], 'background-color': [/^.*$/], 'text-align': [/^(left|right|center|justify)$/],
                    'font-size': [/^\d+(px|em|rem|%)$/], 'font-weight': [/^.*$/], 'font-style': [/^.*$/],
                    'text-decoration': [/^.*$/], 'font-family': [/^.*$/], 'line-height': [/^.*$/]
                }
            },
            transformTags: { 'a': s.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) }
        });
    }
    // Fallback: strip scripts, inline event handlers, and javascript:/data: URLs.
    return String(html)
        .replace(/<\s*(script|style|iframe|object|embed|link|meta)[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .replace(/<\s*(script|style|iframe|object|embed|link|meta)\b[^>]*>/gi, '')
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*'|"\s*data:[^"]*"|'\s*data:[^']*')/gi, '$1="#"');
}
function newSiteKey() { return 'ss_' + randomBytes(12).toString('hex'); }
function embedLoaderSource(origin, siteKey) {
    return `window.PPX={siteKey:"${siteKey}"};(function(d){var s=d.createElement("script");s.src="${origin}/embed.js";(d.body||d.head).appendChild(s);})(document);`;
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Normalize a page URL/path to a comparable "host/path" (or "/path"): lowercase,
// no scheme, no www., no query/hash, no trailing slash. Mirrors api/embed.js.
function normPage(input) {
    let s = String(input == null ? '' : input).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z]+:\/\//, '');
    s = s.split('#')[0].split('?')[0];
    s = s.replace(/^www\./, '');
    if (s.length > 1) s = s.replace(/\/+$/, '');
    return s;
}

// Normalize the interactive (poll / rating / contact-capture) config.
function normalizeSurvey(s) {
    if (!s || typeof s !== 'object' || !s.enabled) return null;
    const str = (v, n) => (v == null ? '' : String(v)).slice(0, n);
    const opts = Array.isArray(s.options) ? s.options.map(o => str(o, 120)).filter(Boolean).slice(0, 6) : [];
    const rating = s.rating && s.rating.enabled ? {
        enabled: true,
        scale: (+s.rating.scale === 10 ? 10 : 5),
        label: str(s.rating.label, 160)
    } : { enabled: false };
    const contact = s.contact && s.contact.enabled ? {
        enabled: true,
        name: !!s.contact.name, email: !!s.contact.email, phone: !!s.contact.phone,
        required: Array.isArray(s.contact.required) ? s.contact.required.filter(f => ['name', 'email', 'phone'].includes(f)) : []
    } : { enabled: false };
    const hasPoll = !!(str(s.question, 300) && opts.length);
    // Nothing actually asked → treat as disabled.
    if (!hasPoll && !rating.enabled && !contact.enabled) return null;
    return {
        enabled: true,
        question: str(s.question, 300),
        options: opts,
        rating, contact,
        thanks: str(s.thanks, 300) || 'Thanks for your response!'
    };
}

const ADMIN_ACTIONS = new Set([
    'list_campaigns', 'get_campaign', 'create_campaign', 'update_campaign',
    'delete_campaign', 'toggle_active', 'get_upload_url', 'get_stats', 'can_access',
    'search_partners', 'export_clicks', 'partners_by_ids',
    'list_sites', 'create_site', 'toggle_site', 'delete_site', 'site_pages', 'set_site_excluded', 'campaign_pages', 'ghl_locations',
    'get_responses', 'export_responses',
    'webflow_status', 'webflow_authorize_url', 'webflow_sync', 'webflow_wire', 'webflow_unwire', 'webflow_disconnect',
    'get_pixels', 'set_pixels', 'export_audience',
    'ghl_forms', 'ghl_calendars', 'get_conversions', 'scan_cta',
    'set_location_token', 'test_location'
]);
const VIEWER_ACTIONS = new Set(['get_active', 'track', 'dismiss', 'submit_response']);

async function validatePartner(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).single();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

// Resolve the caller for viewer actions: partner (body token) or staff (session).
async function resolveViewer(req) {
    const pt = req.body?.partner_token;
    if (pt) { const pid = await validatePartner(pt); if (pid) return { id: String(pid), type: 'partner' }; }
    const s = await validateStaff(req);
    if (s) return { id: String(s.userid), type: 'staff' };
    return null;
}

const ok = (res, data, extra = {}) => res.status(200).json({ success: true, data, ...extra });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

// Stable 0..99 bucket from a string (FNV-1a) — used to split A/B traffic per user.
function hashPct(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0) % 100;
}

// Is this partner (persons.id) tied to a Prime49 agent identifier?
// persons.id → agents.parent_agent_id → agent_identifiers.agent_id (prime49=true)
async function partnerIsPrime49(personId) {
    const { data: ags } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    const agentUuids = (ags || []).map(a => a.id);
    if (!agentUuids.length) return false;
    const { data: idents } = await supabase.from('agent_identifiers')
        .select('id').in('agent_id', agentUuids).eq('prime49', true).limit(1);
    return !!(idents && idents.length);
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
    const action = req.body?.action;
    if (!action) return bad(res, 'No action provided');

    try {
        // ── ADMIN (staff + access_marketing) ──────────────────────────────────
        if (ADMIN_ACTIONS.has(action)) {
            const session = await validateStaff(req);
            if (!session) return sessionErrorResponse(res);
            const { data: caller } = await supabase.from('app_users')
                .select('role, access_marketing, first_name, last_name').eq('userid', session.userid).maybeSingle();
            const canAccess = !!caller && (caller.role === 'super_admin' || caller.role === 'admin' || caller.access_marketing === true);
            if (action === 'can_access') return ok(res, { can_access: canAccess, role: caller?.role || null });
            if (!canAccess) return bad(res, 'You do not have access to Marketing.', 403);
            const actorName = caller ? `${caller.first_name || ''} ${caller.last_name || ''}`.trim() : session.userid;

            if (action === 'list_campaigns') {
                const { data } = await supabase.from('marketing_campaigns').select('*')
                    .order('created_at', { ascending: false });
                // attach quick counts
                const ids = (data || []).map(c => c.id);
                const stats = {};
                if (ids.length) {
                    const { data: ev } = await supabase.from('marketing_events').select('campaign_id, event_type').in('campaign_id', ids);
                    (ev || []).forEach(e => { const s = stats[e.campaign_id] || (stats[e.campaign_id] = { impression: 0, click: 0, dismiss: 0 }); s[e.event_type] = (s[e.event_type] || 0) + 1; });
                }
                return ok(res, (data || []).map(c => ({ ...c, stats: stats[c.id] || { impression: 0, click: 0, dismiss: 0 } })));
            }

            if (action === 'get_campaign') {
                const { id } = req.body;
                const { data } = await supabase.from('marketing_campaigns').select('*').eq('id', id).maybeSingle();
                if (!data) return bad(res, 'Campaign not found', 404);
                return ok(res, data);
            }

            if (action === 'get_upload_url') {
                const ft = String(req.body.file_type || '');
                const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
                const ext = EXT[ft];
                if (!ext) return bad(res, 'Only PNG, JPG, WEBP, or GIF images are allowed.');
                const path = `campaigns/${Date.now()}_${Math.floor(1e6 * (session.userid.length % 7 + 1))}.${ext}`.replace(/[^a-zA-Z0-9._/]/g, '');
                const { data, error } = await supabase.storage.from('marketing').createSignedUploadUrl(path);
                if (error) return bad(res, error.message, 500);
                const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/marketing/${path}`;
                return ok(res, { upload_url: data.signedUrl, public_url: publicUrl, path });
            }

            if (action === 'create_campaign' || action === 'update_campaign') {
                const b = req.body;
                // Variant B body is rich-text too — sanitize it before storing.
                let variantB = (b.variant_b && typeof b.variant_b === 'object') ? { ...b.variant_b } : {};
                if (variantB.body_text != null) variantB.body_text = await sanitizeBody(variantB.body_text);
                const rec = {
                    title: (b.title || '').trim() || 'Untitled',
                    body_text: await sanitizeBody(b.body_text),
                    image_url: b.image_url ?? null,
                    content_type: ['text', 'graphic', 'both'].includes(b.content_type) ? b.content_type : 'both',
                    cta_enabled: !!b.cta_enabled,
                    cta_label: b.cta_label ?? null,
                    cta_url: b.cta_url ?? null,
                    hotspots: Array.isArray(b.hotspots) ? b.hotspots : [],
                    audience: ['partner', 'staff', 'both'].includes(b.audience) ? b.audience : 'partner',
                    display_mode: [
                        'card_dismissible', 'card_persistent', 'card_until_action',
                        'floating_dismissible', 'floating_persistent', 'floating_until_action',
                        'both_dismissible', 'both_persistent', 'both_until_action'
                    ].includes(b.display_mode)
                        ? b.display_mode
                        : (b.display_mode === 'floating' ? 'floating_dismissible' : 'card_dismissible'),
                    reshow_minutes: Number.isFinite(+b.reshow_minutes) && +b.reshow_minutes > 0 ? Math.min(1440, Math.round(+b.reshow_minutes)) : 5,
                    // Targeting (partner audience): 'all' | 'prime49' | 'specific'
                    target_type: ['all', 'prime49', 'specific'].includes(b.target_type) ? b.target_type : 'all',
                    target_partner_ids: Array.isArray(b.target_partner_ids) ? b.target_partner_ids.map(String) : [],
                    // A/B testing
                    ab_enabled: !!b.ab_enabled,
                    ab_split: Number.isFinite(+b.ab_split) ? Math.min(100, Math.max(0, Math.round(+b.ab_split))) : 50,
                    variant_b: variantB,
                    show_on_embed: !!b.show_on_embed,
                    embed_site_ids: Array.isArray(b.embed_site_ids) ? b.embed_site_ids.map(String) : [],
                    ghl_location_ids: Array.isArray(b.ghl_location_ids) ? b.ghl_location_ids.map(String) : [],
                    // Interactive config (poll / rating / contact capture).
                    survey: normalizeSurvey(b.survey),
                    // Per-campaign page exclusions (on top of the per-site baseline).
                    excluded_paths: (() => {
                        const raw = Array.isArray(b.excluded_paths) ? b.excluded_paths : [];
                        const seen = new Set(); const clean = [];
                        raw.forEach(x => { const n = normPage(x); if (n && !seen.has(n)) { seen.add(n); clean.push(n); } });
                        return clean.slice(0, 500);
                    })(),
                    conv_location_id: b.conv_location_id || null,
                    conv_form_id: b.conv_form_id || null, conv_form_name: b.conv_form_name || null,
                    conv_calendar_id: b.conv_calendar_id || null, conv_calendar_name: b.conv_calendar_name || null,
                    is_active: !!b.is_active,
                    starts_at: b.starts_at || null,
                    ends_at: b.ends_at || null,
                    priority: Number.isFinite(+b.priority) ? +b.priority : 0,
                    updated_at: new Date().toISOString()
                };
                let row;
                if (action === 'update_campaign') {
                    if (!b.id) return bad(res, 'id required');
                    const { data, error } = await supabase.from('marketing_campaigns').update(rec).eq('id', b.id).select().single();
                    if (error) return bad(res, error.message);
                    row = data;
                } else {
                    rec.created_by = actorName;
                    const { data, error } = await supabase.from('marketing_campaigns').insert(rec).select().single();
                    if (error) return bad(res, error.message);
                    row = data;
                }
                return ok(res, row);
            }

            if (action === 'toggle_active') {
                const { id, is_active } = req.body;
                const { data, error } = await supabase.from('marketing_campaigns')
                    .update({ is_active: !!is_active, updated_at: new Date().toISOString() }).eq('id', id).select().single();
                if (error) return bad(res, error.message);
                return ok(res, data);
            }

            if (action === 'delete_campaign') {
                const { id } = req.body;
                const { error } = await supabase.from('marketing_campaigns').delete().eq('id', id);
                if (error) return bad(res, error.message);
                return ok(res, { deleted: true });
            }

            if (action === 'get_stats') {
                const { id } = req.body;
                const { data: ev } = await supabase.from('marketing_events')
                    .select('event_type, user_id, user_type, target, created_at, variant, site_id, ghl_location, meta, country').eq('campaign_id', id);
                const rows = ev || [];
                const uniq = (t) => new Set(rows.filter(r => r.event_type === t).map(r => r.user_id)).size;
                const impressions = rows.filter(r => r.event_type === 'impression').length;
                const clicks = rows.filter(r => r.event_type === 'click').length;
                const dismissals = rows.filter(r => r.event_type === 'dismiss').length;
                const uImp = uniq('impression'), uClick = uniq('click');
                // clicks broken down by target (hotspot/cta)
                const byTarget = {};
                rows.filter(r => r.event_type === 'click').forEach(r => { const k = r.target || 'cta'; byTarget[k] = (byTarget[k] || 0) + 1; });
                // ── Resolve NAMES + CHANNEL for each person ──────────────────────
                const staffIds = [...new Set(rows.filter(r => r.user_type === 'staff').map(r => r.user_id).filter(Boolean))];
                const partnerIds = [...new Set(rows.filter(r => r.user_type === 'partner').map(r => r.user_id).filter(Boolean))];
                const siteIds = [...new Set(rows.filter(r => r.site_id).map(r => r.site_id))];
                const ghlLocs = [...new Set(rows.filter(r => r.ghl_location).map(r => r.ghl_location))];
                const nameMap = {};
                const siteNames = {};
                let locNames = {};
                if (staffIds.length) {
                    const { data: su } = await supabase.from('app_users').select('userid, first_name, last_name').in('userid', staffIds);
                    (su || []).forEach(u => { nameMap['staff:' + u.userid] = `${u.first_name || ''} ${u.last_name || ''}`.trim() || ('Staff #' + u.userid); });
                }
                if (partnerIds.length) {
                    const { data: pp } = await supabase.from('persons').select('id, full_name').in('id', partnerIds);
                    (pp || []).forEach(p => { nameMap['partner:' + p.id] = p.full_name || 'Partner'; });
                }
                if (siteIds.length) {
                    const { data: sites } = await supabase.from('marketing_sites').select('id, name').in('id', siteIds);
                    (sites || []).forEach(s => { siteNames[s.id] = s.name || 'Site'; });
                }
                if (ghlLocs.length) { try { locNames = await ghlLocationNames(ghlLocs); } catch { locNames = {}; } }

                // Classify one event → { name, channel, source } where channel is
                // 'staff' | 'partner' | 'ghl' | 'website'.
                const classify = (r) => {
                    if (r.user_type === 'staff') return { name: nameMap['staff:' + r.user_id] || 'Staff', channel: 'staff', source: 'Staff portal' };
                    if (r.user_type === 'partner') return { name: nameMap['partner:' + r.user_id] || 'Partner', channel: 'partner', source: 'Partner portal' };
                    // embed viewer (external site / GHL)
                    const email = String(r.user_id || '').indexOf('email:') === 0 ? String(r.user_id).slice(6) : '';
                    if (r.ghl_location) {
                        const acct = locNames[r.ghl_location] || 'GoHighLevel sub-account';
                        return { name: email || acct, channel: 'ghl', source: acct };
                    }
                    const site = r.site_id ? (siteNames[r.site_id] || 'Website') : 'Website';
                    return { name: email || 'Website visitor', channel: 'website', source: site };
                };

                const byAudience = { partner: 0, staff: 0, ghl: 0, website: 0 };
                rows.filter(r => r.event_type === 'click').forEach(r => { const ch = classify(r).channel; if (byAudience[ch] != null) byAudience[ch]++; });

                // Aggregate a per-person list for a given event type (most recent first).
                const peopleFor = (evType) => {
                    const by = {};
                    rows.filter(r => r.event_type === evType).forEach(r => {
                        const key = r.user_type + ':' + r.user_id;
                        if (!by[key]) { const c = classify(r); by[key] = { name: c.name, channel: c.channel, source: c.source, user_type: r.user_type, count: 0, targets: {}, last_at: r.created_at }; }
                        const e = by[key];
                        e.count++;
                        if (evType === 'click') { const t = r.target || 'cta'; e.targets[t] = (e.targets[t] || 0) + 1; }
                        if (r.created_at > e.last_at) e.last_at = r.created_at;
                    });
                    return Object.values(by).sort((a, b) => (b.last_at || '').localeCompare(a.last_at || ''));
                };

                // ── A/B breakdown (unique viewers/clickers + CTR per variant) ────
                const abFor = (variant) => {
                    const vr = rows.filter(r => r.variant === variant);
                    const vi = new Set(vr.filter(r => r.event_type === 'impression').map(r => r.user_id)).size;
                    const vc = new Set(vr.filter(r => r.event_type === 'click').map(r => r.user_id)).size;
                    return { impressions: vr.filter(r => r.event_type === 'impression').length, clicks: vr.filter(r => r.event_type === 'click').length,
                        unique_impressions: vi, unique_clicks: vc, ctr: vi ? Math.round((vc / vi) * 1000) / 10 : 0 };
                };
                const hasAb = rows.some(r => r.variant === 'A' || r.variant === 'B');

                // ── Per-site (embed) breakdown: views + clicks per external site ──
                let bySite = null;
                if (siteIds.length) {
                    const acc = {};
                    rows.filter(r => r.site_id).forEach(r => {
                        const e = acc[r.site_id] || (acc[r.site_id] = { name: siteNames[r.site_id] || 'Site', impressions: 0, clicks: 0 });
                        if (r.event_type === 'impression') e.impressions++;
                        else if (r.event_type === 'click') e.clicks++;
                    });
                    bySite = Object.values(acc).sort((a, b) => b.clicks - a.clicks);
                }

                // ── Traffic sources (embed views) — only count views that actually
                // carry data, so pre-tracking / direct-with-no-data views don't
                // swamp the report. Referrer/UTM are empty for direct/untagged
                // traffic; landing page + device + country are the reliable ones.
                const embedImp = rows.filter(r => r.user_type === 'embed' && r.event_type === 'impression');
                const dataImp = embedImp.filter(r => r.meta || r.country);
                const host = (u) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };
                const pagePath = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/+$/, '') || (x.hostname.replace(/^www\./, '') + '/'); } catch { return ''; } };
                const bucket = (keyFn) => {
                    const acc = {};
                    dataImp.forEach(r => { const k = keyFn(r) || '(none)'; acc[k] = (acc[k] || 0) + 1; });
                    return Object.entries(acc).map(([name, count]) => ({ name, count, pct: Math.round(count / dataImp.length * 100) }))
                        .sort((a, b) => b.count - a.count).slice(0, 10);
                };
                const traffic = dataImp.length ? {
                    coverage: { with_data: dataImp.length, total: embedImp.length },
                    pages: bucket(r => pagePath(r.meta && r.meta.url) || '(unknown)'),
                    referrers: bucket(r => host(r.meta && r.meta.ref) || '(direct)'),
                    sources: bucket(r => (r.meta && r.meta.utm_source) || '(none)'),
                    countries: bucket(r => r.country || '(unknown)'),
                    devices: bucket(r => (r.meta && r.meta.device) || '(unknown)')
                } : null;

                return ok(res, {
                    impressions, clicks, dismissals,
                    unique_impressions: uImp, unique_clicks: uClick,
                    ctr: uImp ? Math.round((uClick / uImp) * 1000) / 10 : 0,   // % of unique viewers who clicked
                    clicks_by_target: byTarget, clicks_by_audience: byAudience,
                    clickers: peopleFor('click'),
                    viewers: peopleFor('impression'),
                    dismissers: peopleFor('dismiss'),
                    ab: hasAb ? { A: abFor('A'), B: abFor('B') } : null,
                    by_site: bySite,
                    traffic
                });
            }

            // Partner lookup for the "specific partners" targeting picker.
            if (action === 'search_partners') {
                const { data, error } = await supabase.rpc('search_partners', { q: (req.body.query || '').trim() });
                if (error) return bad(res, error.message);
                return ok(res, (data || []).map(r => ({
                    id: r.person_id, full_name: r.full_name, email: r.email,
                    company_name: r.company_names || null
                })));
            }

            // ── Embed sites registry ─────────────────────────────────────────
            if (action === 'list_sites') {
                const { data } = await supabase.from('marketing_sites').select('*').order('created_at', { ascending: false });
                return ok(res, data || []);
            }
            if (action === 'create_site') {
                const name = (req.body.name || '').trim() || 'Untitled site';
                // Readable, unguessable key: ss_ + 24 hex chars.
                const rand = Array.from({ length: 24 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
                const site_key = 'ss_' + rand;
                const { data, error } = await supabase.from('marketing_sites')
                    .insert({ site_key, name, created_by: actorName }).select().single();
                if (error) return bad(res, error.message);
                return ok(res, data);
            }
            if (action === 'toggle_site') {
                const { id, is_active } = req.body;
                const { data, error } = await supabase.from('marketing_sites').update({ is_active: !!is_active }).eq('id', id).select().single();
                if (error) return bad(res, error.message);
                return ok(res, data);
            }
            if (action === 'delete_site') {
                const { error } = await supabase.from('marketing_sites').delete().eq('id', req.body.id);
                if (error) return bad(res, error.message);
                return ok(res, { deleted: true });
            }
            // Interactive responses for a campaign (poll tallies, ratings, leads).
            if (action === 'get_responses') {
                const { campaign_id } = req.body;
                if (!campaign_id) return bad(res, 'campaign_id required');
                const { data: rows } = await supabase.from('marketing_responses')
                    .select('*').eq('campaign_id', campaign_id).order('created_at', { ascending: false }).limit(5000);
                const list = rows || [];
                const pollTally = {}; let ratingSum = 0, ratingCount = 0; const leads = [];
                let promoters = 0, detractors = 0, passives = 0, npsScale = false;
                list.forEach(r => {
                    if (r.choice) pollTally[r.choice] = (pollTally[r.choice] || 0) + 1;
                    if (Number.isFinite(r.rating)) {
                        ratingSum += r.rating; ratingCount++;
                        if (r.rating >= 7) { if (r.rating >= 9) promoters++; else passives++; npsScale = true; }
                        else if (r.rating <= 6 && r.rating >= 0) { /* handled below */ }
                        if (r.rating <= 6) detractors++;
                    }
                    if (r.email || r.phone || r.name) leads.push({ name: r.name, email: r.email, phone: r.phone, created_at: r.created_at, user_type: r.user_type });
                });
                const nps = ratingCount ? Math.round(((promoters - detractors) / ratingCount) * 100) : null;
                const avgRating = ratingCount ? (ratingSum / ratingCount) : null;
                return ok(res, { total: list.length, poll: pollTally, rating: { count: ratingCount, avg: avgRating, nps: npsScale ? nps : null, promoters, passives, detractors }, leads });
            }
            if (action === 'export_responses') {
                const { campaign_id } = req.body;
                if (!campaign_id) return bad(res, 'campaign_id required');
                const { data: rows } = await supabase.from('marketing_responses')
                    .select('created_at, user_type, choice, rating, name, email, phone').eq('campaign_id', campaign_id).order('created_at', { ascending: false }).limit(20000);
                const esc = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
                const header = 'created_at,user_type,choice,rating,name,email,phone';
                const csv = [header].concat((rows || []).map(r => [r.created_at, r.user_type, r.choice, r.rating, r.name, r.email, r.phone].map(esc).join(','))).join('\n');
                return ok(res, { csv });
            }
            // Observed pages for a site (the "rabbit hole"): distinct pages visitors
            // actually loaded the announcement on, from tracked events. Returns each
            // normalized host/path with a hit count + the site's current exclusions.
            if (action === 'site_pages') {
                const { id } = req.body;
                if (!id) return bad(res, 'site id required');
                const { data: site } = await supabase.from('marketing_sites').select('id, name, excluded_paths').eq('id', id).maybeSingle();
                if (!site) return bad(res, 'Site not found', 404);
                const { data: evs } = await supabase.from('marketing_events')
                    .select('meta, created_at').eq('site_id', id)
                    .not('meta', 'is', null).order('created_at', { ascending: false }).limit(4000);
                const counts = {}; const lastSeen = {};
                (evs || []).forEach(e => {
                    const u = e.meta && e.meta.url;
                    if (!u) return;
                    const p = normPage(u);
                    if (!p) return;
                    counts[p] = (counts[p] || 0) + 1;
                    if (!lastSeen[p]) lastSeen[p] = e.created_at;
                });
                const pages = Object.keys(counts).map(p => ({ page: p, hits: counts[p], last_seen: lastSeen[p] }))
                    .sort((a, b) => b.hits - a.hits);
                return ok(res, { pages, excluded_paths: site.excluded_paths || [], site_name: site.name });
            }
            // Observed pages across a campaign's target sites (for per-campaign
            // exclusions). site_ids empty = all embed sites. Returns pages (host/path)
            // with hit counts.
            if (action === 'campaign_pages') {
                const siteIds = Array.isArray(req.body.site_ids) ? req.body.site_ids.map(String) : [];
                let q = supabase.from('marketing_events').select('meta, created_at, site_id')
                    .not('meta', 'is', null).not('site_id', 'is', null)
                    .order('created_at', { ascending: false }).limit(5000);
                if (siteIds.length) q = q.in('site_id', siteIds);
                const { data: evs } = await q;
                const counts = {}; const lastSeen = {};
                (evs || []).forEach(e => {
                    const u = e.meta && e.meta.url; if (!u) return;
                    const p = normPage(u); if (!p) return;
                    counts[p] = (counts[p] || 0) + 1;
                    if (!lastSeen[p]) lastSeen[p] = e.created_at;
                });
                const pages = Object.keys(counts).map(p => ({ page: p, hits: counts[p], last_seen: lastSeen[p] }))
                    .sort((a, b) => b.hits - a.hits);
                return ok(res, { pages });
            }
            // Save the per-site exclusion list (normalized + de-duped).
            if (action === 'set_site_excluded') {
                const { id } = req.body;
                if (!id) return bad(res, 'site id required');
                const raw = Array.isArray(req.body.excluded_paths) ? req.body.excluded_paths : [];
                const seen = new Set(); const clean = [];
                raw.forEach(x => { const n = normPage(x); if (n && !seen.has(n)) { seen.add(n); clean.push(n); } });
                if (clean.length > 500) return bad(res, 'Too many excluded paths (max 500).');
                const { data, error } = await supabase.from('marketing_sites')
                    .update({ excluded_paths: clean }).eq('id', id).select('id, excluded_paths').single();
                if (error) return bad(res, error.message);
                return ok(res, data);
            }

            // Live list of GHL sub-accounts (for the targeting picker).
            if (action === 'ghl_locations') {
                const r = await ghlListLocations();
                return ok(res, r);
            }

            // Store a per-sub-account Private Integration token (encrypted).
            if (action === 'set_location_token') {
                const { location_id, token } = req.body;
                if (!location_id) return bad(res, 'location_id required');
                await setConfigValue('GHL_LOCTOKEN:' + location_id, (token || '').trim(), actorName);
                return ok(res, { saved: true });
            }
            // Verify a sub-account is readable (lists forms + calendars).
            if (action === 'test_location') {
                const { location_id } = req.body;
                if (!location_id) return bad(res, 'location_id required');
                const [forms, cals] = await Promise.all([ghlListForms(location_id), ghlListCalendars(location_id)]);
                return ok(res, { forms: forms.length, calendars: cals.length });
            }

            // Forms / calendars in a sub-account (for the conversion-source pickers).
            if (action === 'ghl_forms') {
                if (!req.body.location_id) return ok(res, []);
                return ok(res, await ghlListForms(req.body.location_id));
            }
            if (action === 'ghl_calendars') {
                if (!req.body.location_id) return ok(res, []);
                return ok(res, await ghlListCalendars(req.body.location_id));
            }

            // Scan a CTA landing page for an embedded GHL form / calendar and
            // return its type + id (handles GHL widgets embedded on Webflow).
            if (action === 'scan_cta') {
                let url = String(req.body.url || '').trim();
                if (!/^https?:\/\//i.test(url)) return bad(res, 'Enter a valid http(s) link.');
                // Basic SSRF guard: block internal hosts.
                try {
                    const h = new URL(url).hostname;
                    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(h)) return bad(res, 'Blocked host.');
                } catch { return bad(res, 'Bad URL.'); }
                let htmlText = '';
                try {
                    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 PPTAnnounceBot' } });
                    htmlText = (await r.text()).slice(0, 800000);   // cap size
                } catch (e) { return bad(res, 'Could not fetch the page: ' + (e.message || 'error')); }
                // Also scan the URL itself (in case the CTA links straight to a widget).
                const hay = url + '\n' + htmlText;
                const grab = (re) => { const m = hay.match(re); return m ? m[1] : null; };
                const formId = grab(/widget\/form\/([A-Za-z0-9]{6,40})/) || grab(/data-form-id=["']([A-Za-z0-9]{6,40})["']/) || grab(/[?&]formId=([A-Za-z0-9]{6,40})/);
                const calId = grab(/widget\/bookings?\/([A-Za-z0-9]{6,40})/) || grab(/data-(?:calendar|widget)-id=["']([A-Za-z0-9]{6,40})["']/) || grab(/[?&]calendarId=([A-Za-z0-9]{6,40})/) || grab(/\/widget\/appointment\/([A-Za-z0-9]{6,40})/);
                const locId = grab(/[?&]locationId=([A-Za-z0-9]{6,40})/) || grab(/data-location-id=["']([A-Za-z0-9]{6,40})["']/);
                if (!formId && !calId) return ok(res, { found: false });
                return ok(res, { found: true, form_id: formId, calendar_id: calId, location_id: locId });
            }

            // Live conversions for a campaign (form submissions + appointments within its window).
            if (action === 'get_conversions') {
                const { id } = req.body;
                const { data: c } = await supabase.from('marketing_campaigns')
                    .select('conv_location_id, conv_form_id, conv_calendar_id, starts_at, ends_at, created_at').eq('id', id).maybeSingle();
                if (!c || !c.conv_location_id || (!c.conv_form_id && !c.conv_calendar_id)) return ok(res, { configured: false, count: 0, list: [] });
                const startMs = c.starts_at ? new Date(c.starts_at).getTime() : (c.created_at ? new Date(c.created_at).getTime() : Date.now() - 90 * 864e5);
                const endMs = c.ends_at ? Math.min(new Date(c.ends_at).getTime(), Date.now()) : Date.now();
                const [forms, appts] = await Promise.all([
                    ghlFormSubmissions(c.conv_location_id, c.conv_form_id, startMs, endMs),
                    ghlCalendarAppointments(c.conv_location_id, c.conv_calendar_id, startMs, endMs)
                ]);
                const list = [...(forms || []), ...(appts || [])].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
                const byType = {};
                list.forEach(x => { byType[x.type] = (byType[x.type] || 0) + 1; });
                return ok(res, { configured: true, count: list.length, by_type: byType, list: list.slice(0, 100) });
            }

            // ── Webflow connector ────────────────────────────────────────────
            if (action === 'webflow_status') {
                const token = await webflow.getToken();
                const { data: sites } = await supabase.from('marketing_sites')
                    .select('id, name, site_key, webflow_site_id, wired, is_active')
                    .eq('provider', 'webflow').order('name');
                return ok(res, { app_configured: webflow.webflowConfigured(), connected: !!token, sites: sites || [] });
            }

            if (action === 'webflow_authorize_url') {
                if (!webflow.webflowConfigured()) return bad(res, 'Add WEBFLOW_CLIENT_ID and WEBFLOW_CLIENT_SECRET in Vercel first.');
                const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
                const host = req.headers['x-forwarded-host'] || req.headers.host;
                const redirectUri = `${proto}://${host}/api/webflow-oauth`;
                const state = randomBytes(16).toString('hex');
                await setConfigValue('WEBFLOW_OAUTH_STATE', state, actorName);
                return ok(res, { url: webflow.authorizeUrl(redirectUri, state) });
            }

            // Pull Webflow sites → ensure a marketing_sites row (+ key) for each.
            if (action === 'webflow_sync') {
                let sites;
                try { sites = await webflow.listSites(); } catch (e) { return bad(res, e.message); }
                for (const s of sites) {
                    const { data: existing } = await supabase.from('marketing_sites').select('id').eq('webflow_site_id', s.id).maybeSingle();
                    if (!existing) {
                        await supabase.from('marketing_sites').insert({
                            site_key: newSiteKey(), name: s.name, provider: 'webflow', webflow_site_id: s.id, created_by: actorName
                        });
                    } else {
                        await supabase.from('marketing_sites').update({ name: s.name }).eq('id', existing.id);
                    }
                }
                const { data: rows } = await supabase.from('marketing_sites')
                    .select('id, name, site_key, webflow_site_id, wired, is_active').eq('provider', 'webflow').order('name');
                return ok(res, rows || []);
            }

            // Inject the loader on a Webflow site (register inline script + apply + publish).
            if (action === 'webflow_wire' || action === 'webflow_unwire') {
                const { id } = req.body;
                const { data: site } = await supabase.from('marketing_sites').select('*').eq('id', id).maybeSingle();
                if (!site || !site.webflow_site_id) return bad(res, 'Webflow site not found');
                try {
                    if (action === 'webflow_wire') {
                        const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
                        const host = req.headers['x-forwarded-host'] || req.headers.host;
                        const origin = `${proto}://${host}`;
                        const src = embedLoaderSource(origin, site.site_key);
                        const scriptId = await webflow.ensureInlineScript(site.webflow_site_id, src, 'PPTAnnounce', '1.0.0');
                        await webflow.applyFooterScript(site.webflow_site_id, scriptId, '1.0.0');
                        await webflow.publishSite(site.webflow_site_id);
                        await supabase.from('marketing_sites').update({ wired: true, script_id: scriptId, is_active: true }).eq('id', id);
                    } else {
                        await webflow.clearCustomCode(site.webflow_site_id);
                        await webflow.publishSite(site.webflow_site_id);
                        await supabase.from('marketing_sites').update({ wired: false }).eq('id', id);
                    }
                } catch (e) { return bad(res, e.message); }
                return ok(res, { ok: true });
            }

            if (action === 'webflow_disconnect') {
                await webflow.disconnect();
                return ok(res, { disconnected: true });
            }

            // ── Retargeting pixels ───────────────────────────────────────────
            if (action === 'get_pixels') {
                const { data } = await supabase.from('marketing_pixels').select('*').eq('id', 1).maybeSingle();
                return ok(res, data || {});
            }
            if (action === 'set_pixels') {
                const b = req.body;
                const rec = {
                    id: 1,
                    fb_pixel_id: (b.fb_pixel_id || '').trim() || null,
                    google_tag_id: (b.google_tag_id || '').trim() || null,
                    linkedin_partner_id: (b.linkedin_partner_id || '').trim() || null,
                    fb_enabled: !!b.fb_enabled, google_enabled: !!b.google_enabled, linkedin_enabled: !!b.linkedin_enabled,
                    updated_at: new Date().toISOString()
                };
                const { data, error } = await supabase.from('marketing_pixels').upsert(rec, { onConflict: 'id' }).select().single();
                if (error) return bad(res, error.message);
                return ok(res, data);
            }

            // Ad-audience export: unique external visitors with their retargeting
            // identifiers (SHA-256 email for Custom Audience/Customer Match uploads,
            // plus click-IDs / pixel cookies for server-side CAPI).
            if (action === 'export_audience') {
                const { id } = req.body;   // optional campaign filter
                let q = supabase.from('marketing_events')
                    .select('user_id, meta, country, created_at, campaign_id').eq('user_type', 'embed');
                if (id) q = q.eq('campaign_id', id);
                const { data: ev } = await q.order('created_at', { ascending: false }).limit(5000);
                const byViewer = {};
                (ev || []).forEach(r => {
                    if (byViewer[r.user_id]) return;   // newest wins (ordered desc)
                    const m = r.meta || {};
                    const email = String(r.user_id || '').indexOf('email:') === 0 ? String(r.user_id).slice(6) : '';
                    byViewer[r.user_id] = {
                        email, email_sha256: m.email_sha256 || '',
                        fbp: m.fbp || '', fbc: m.fbc || '', gcl_au: m.gcl_au || '',
                        fbclid: m.fbclid || '', gclid: m.gclid || '', li_fat_id: m.li_fat_id || '',
                        country: r.country || '', last_seen: r.created_at
                    };
                });
                // Only rows that carry at least one retargeting identifier.
                const out = Object.values(byViewer).filter(x => x.email_sha256 || x.fbp || x.gclid || x.li_fat_id || x.fbclid || x.gcl_au || x.email);
                return ok(res, out);
            }

            // Resolve names for a set of saved partner ids (edit → chips).
            if (action === 'partners_by_ids') {
                const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
                if (!ids.length) return ok(res, []);
                const { data } = await supabase.from('persons').select('id, full_name').in('id', ids);
                return ok(res, (data || []).map(p => ({ id: p.id, full_name: p.full_name || 'Partner' })));
            }

            // Detailed click-through rows for CSV export (names + emails resolved).
            if (action === 'export_clicks') {
                const { id, event_type } = req.body;
                const type = ['click', 'impression', 'dismiss'].includes(event_type) ? event_type : 'click';
                const { data: ev } = await supabase.from('marketing_events')
                    .select('event_type, user_id, user_type, target, created_at, variant, site_id, ghl_location, meta, country')
                    .eq('campaign_id', id).eq('event_type', type).order('created_at', { ascending: false });
                const rows = ev || [];
                const staffIds = [...new Set(rows.filter(r => r.user_type === 'staff').map(r => r.user_id).filter(Boolean))];
                const partnerIds = [...new Set(rows.filter(r => r.user_type === 'partner').map(r => r.user_id).filter(Boolean))];
                const eSiteIds = [...new Set(rows.filter(r => r.site_id).map(r => r.site_id))];
                const eLocs = [...new Set(rows.filter(r => r.ghl_location).map(r => r.ghl_location))];
                const info = {}, sNames = {};
                let lNames = {};
                if (staffIds.length) {
                    const { data: su } = await supabase.from('app_users').select('userid, first_name, last_name, email').in('userid', staffIds);
                    (su || []).forEach(u => { info['staff:' + u.userid] = { name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), email: u.email || '' }; });
                }
                if (partnerIds.length) {
                    const { data: pp } = await supabase.from('persons').select('id, full_name, email').in('id', partnerIds);
                    (pp || []).forEach(p => { info['partner:' + p.id] = { name: p.full_name || '', email: p.email || '' }; });
                }
                if (eSiteIds.length) { const { data: ss } = await supabase.from('marketing_sites').select('id, name').in('id', eSiteIds); (ss || []).forEach(s => { sNames[s.id] = s.name || 'Site'; }); }
                if (eLocs.length) { try { lNames = await ghlLocationNames(eLocs); } catch { lNames = {}; } }
                const host = (u) => { try { return u ? new URL(u).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };
                const out = rows.map(r => {
                    const m = r.meta || {};
                    const traffic = { referrer: host(m.ref) || (r.user_type === 'embed' ? 'direct' : ''), utm_source: m.utm_source || '', country: r.country || '', device: m.device || '', landing: m.url || '' };
                    if (r.user_type === 'embed') {
                        const email = String(r.user_id || '').indexOf('email:') === 0 ? String(r.user_id).slice(6) : '';
                        const channel = r.ghl_location ? 'GHL' : 'Website';
                        const source = r.ghl_location ? (lNames[r.ghl_location] || 'GoHighLevel sub-account') : (r.site_id ? (sNames[r.site_id] || 'Website') : 'Website');
                        return { name: email || (r.ghl_location ? source : 'Website visitor'), email, user_type: channel, source, target: r.target || '', variant: r.variant || '', at: r.created_at, ...traffic };
                    }
                    const i = info[r.user_type + ':' + r.user_id] || { name: '', email: '' };
                    return { name: i.name || (r.user_type === 'partner' ? 'Partner' : 'Staff'), email: i.email, user_type: r.user_type === 'partner' ? 'Partner' : 'Staff', source: r.user_type === 'partner' ? 'Partner portal' : 'Staff portal', target: r.target || '', variant: r.variant || '', at: r.created_at, ...traffic };
                });
                return ok(res, out);
            }
        }

        // ── VIEWER (partner or staff) ─────────────────────────────────────────
        if (VIEWER_ACTIONS.has(action)) {
            const who = await resolveViewer(req);
            if (!who) return bad(res, 'Not authenticated', 401);

            if (action === 'get_active') {
                // Active + audience match; date-window + dismissals filtered in JS for clarity.
                const { data: all } = await supabase.from('marketing_campaigns').select('*')
                    .eq('is_active', true)
                    .in('audience', [who.type, 'both'])
                    .order('priority', { ascending: false })
                    .order('created_at', { ascending: false });
                const now = Date.now();
                let live = (all || []).filter(c =>
                    (!c.starts_at || new Date(c.starts_at).getTime() <= now) &&
                    (!c.ends_at || new Date(c.ends_at).getTime() >= now));

                // ── Targeting (partner audience only) ────────────────────────────
                // Staff always see staff/both campaigns; segmentation applies to
                // partners: 'all' | 'specific' (id list) | 'prime49' (has a prime49 ID).
                if (who.type === 'partner') {
                    const needsPrime49 = live.some(c => c.target_type === 'prime49');
                    let isPrime49 = false;
                    if (needsPrime49) isPrime49 = await partnerIsPrime49(who.id);
                    live = live.filter(c => {
                        const tt = c.target_type || 'all';
                        if (tt === 'specific') return (c.target_partner_ids || []).map(String).includes(String(who.id));
                        if (tt === 'prime49') return isPrime49;
                        return true;   // 'all'
                    });
                }

                // exclude ones this user dismissed
                const ids = live.map(c => c.id);
                let dismissed = new Set();
                if (ids.length) {
                    const { data: dis } = await supabase.from('marketing_dismissals')
                        .select('campaign_id').in('campaign_id', ids).eq('user_id', who.id);
                    dismissed = new Set((dis || []).map(d => d.campaign_id));
                }
                const out = live.filter(c => !dismissed.has(c.id)).map(c => {
                    // ── A/B: deterministically show variant A or B per user ──────
                    let variant = null, v = c;
                    if (c.ab_enabled) {
                        const bucket = hashPct(String(who.id) + ':' + c.id);   // 0..99, stable per user+campaign
                        variant = bucket < (c.ab_split ?? 50) ? 'A' : 'B';
                        if (variant === 'B') {
                            const vb = c.variant_b || {};
                            v = {
                                ...c,
                                title: vb.title ?? c.title,
                                body_text: vb.body_text ?? c.body_text,
                                image_url: vb.image_url ?? c.image_url,
                                cta_enabled: vb.cta_enabled ?? c.cta_enabled,
                                cta_label: vb.cta_label ?? c.cta_label,
                                cta_url: vb.cta_url ?? c.cta_url,
                                hotspots: Array.isArray(vb.hotspots) ? vb.hotspots : (c.hotspots || [])
                            };
                        }
                    }
                    return {
                        id: c.id, title: v.title, body_text: v.body_text, image_url: v.image_url,
                        content_type: c.content_type, cta_enabled: v.cta_enabled, cta_label: v.cta_label,
                        cta_url: v.cta_url, hotspots: v.hotspots || [], priority: c.priority,
                        display_mode: c.display_mode || 'card_dismissible',
                        reshow_minutes: c.reshow_minutes || 5,
                        survey: c.survey || null,
                        variant
                    };
                });
                return ok(res, out);
            }

            if (action === 'submit_response') {
                const { campaign_id, choice, rating, name, email, phone, variant } = req.body;
                if (!campaign_id) return bad(res, 'campaign_id required');
                await supabase.from('marketing_responses').insert({
                    campaign_id, variant: (variant === 'A' || variant === 'B') ? variant : null,
                    user_type: who.type, user_id: who.id,
                    choice: choice ? String(choice).slice(0, 200) : null,
                    rating: Number.isFinite(+rating) ? Math.round(+rating) : null,
                    name: name ? String(name).slice(0, 160) : null,
                    email: email ? String(email).slice(0, 200) : null,
                    phone: phone ? String(phone).slice(0, 60) : null
                });
                await supabase.from('marketing_events').insert({
                    campaign_id, user_id: who.id, user_type: who.type, event_type: 'click',
                    target: 'survey', variant: (variant === 'A' || variant === 'B') ? variant : null
                });
                return ok(res, { saved: true });
            }

            if (action === 'track') {
                const { campaign_id, event_type, target, variant } = req.body;
                if (!campaign_id || !['impression', 'click', 'dismiss'].includes(event_type)) return bad(res, 'campaign_id and valid event_type required');
                // De-dupe impressions: one per user per campaign per day
                if (event_type === 'impression') {
                    const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
                    const { data: recent } = await supabase.from('marketing_events').select('id')
                        .eq('campaign_id', campaign_id).eq('user_id', who.id).eq('event_type', 'impression')
                        .gte('created_at', since).limit(1);
                    if (recent && recent.length) return ok(res, { logged: false });
                }
                await supabase.from('marketing_events').insert({
                    campaign_id, user_id: who.id, user_type: who.type, event_type,
                    target: target || null, variant: (variant === 'A' || variant === 'B') ? variant : null
                });
                return ok(res, { logged: true });
            }

            if (action === 'dismiss') {
                const { campaign_id } = req.body;
                if (!campaign_id) return bad(res, 'campaign_id required');
                await supabase.from('marketing_dismissals')
                    .upsert({ campaign_id, user_id: who.id, user_type: who.type }, { onConflict: 'campaign_id,user_id' });
                await supabase.from('marketing_events').insert({ campaign_id, user_id: who.id, user_type: who.type, event_type: 'dismiss' });
                return ok(res, { dismissed: true });
            }
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
