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
import { ghlListLocations, ghlLocationNames } from './_ghl.js';
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

const ADMIN_ACTIONS = new Set([
    'list_campaigns', 'get_campaign', 'create_campaign', 'update_campaign',
    'delete_campaign', 'toggle_active', 'get_upload_url', 'get_stats', 'can_access',
    'search_partners', 'export_clicks', 'partners_by_ids',
    'list_sites', 'create_site', 'toggle_site', 'delete_site', 'ghl_locations',
    'webflow_status', 'webflow_authorize_url', 'webflow_sync', 'webflow_wire', 'webflow_unwire', 'webflow_disconnect'
]);
const VIEWER_ACTIONS = new Set(['get_active', 'track', 'dismiss']);

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

            // Live list of GHL sub-accounts (for the targeting picker).
            if (action === 'ghl_locations') {
                const r = await ghlListLocations();
                return ok(res, r);
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
                        variant
                    };
                });
                return ok(res, out);
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
