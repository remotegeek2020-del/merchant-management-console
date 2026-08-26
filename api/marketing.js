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
import { ghlListLocations, ghlLocationNames, ghlListForms, ghlListCalendars, ghlFormSubmissions, ghlCalendarAppointments, ghlListTags, ghlUpsertContact, ghlContactTags, ghlContactInfo, ghlListWorkflows, ghlAddContactToWorkflow } from './_ghl.js';
import { setConfigValue, getConfigValue } from './api-config.js';
import { logActivity } from './_activity.js';
import * as webflow from './_webflow.js';
import { normEmail, recordOptin, recordOptins, optedInIds } from './_marketing-optins.js';
import { ytEmbed } from './_yt.js';

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

// Resolve a portal viewer's email (partner → persons.email, staff → app_users.email).
// Used for cross-device opt-in suppression. Best-effort; returns '' if unknown.
async function viewerEmailOf(who) {
    if (!who || !who.id) return '';
    try {
        if (who.type === 'partner') {
            const { data } = await supabase.from('persons').select('email').eq('id', who.id).maybeSingle();
            return normEmail(data && data.email);
        }
        if (who.type === 'staff') {
            const { data } = await supabase.from('app_users').select('email').eq('userid', who.id).maybeSingle();
            return normEmail(data && data.email);
        }
    } catch (_) { /* best-effort */ }
    return '';
}

// Authoritative backfill: pull a campaign's GHL gate/conversion-form submissions
// and record each signer's email into the opt-in registry, so the announcement
// stays hidden for people who registered even if the browser never fired a
// dismiss. Best-effort; only runs for campaigns wired to a GHL conversion form.
async function syncCampaignOptins(c) {
    if (!c || !c.conv_location_id || !(c.conv_form_id || c.conv_calendar_id)) return 0;
    try {
        const list = await convFetch(c);
        return await recordOptins(supabase, c.id, list, 'ghl_sync');
    } catch (_) { return 0; }
}

// Fire a campaign's "click → HighLevel workflow" action for one clicker.
// Upserts the contact in the configured sub-account (with tags) and enrolls them
// in the chosen workflow. Best-effort/non-blocking — a click is never held up or
// failed because GHL is slow/down. `person` = { name, email, phone }.
async function fireClickWorkflow(campaignId, person) {
    try {
        if (!person || !person.email) return;   // need an identity to upsert
        const { data: c } = await supabase.from('marketing_campaigns').select('click_workflow').eq('id', campaignId).maybeSingle();
        const cw = c && c.click_workflow;
        if (!cw || !cw.enabled || !cw.location_id) return;
        const up = await ghlUpsertContact(cw.location_id, person, Array.isArray(cw.tags) ? cw.tags : []);
        if (up.ok && up.id && cw.workflow_id) {
            await ghlAddContactToWorkflow(cw.location_id, up.id, cw.workflow_id);
        }
    } catch (_) { /* best-effort */ }
}

// Resolve a portal viewer's contact details (name/email/phone) for the workflow push.
async function viewerContactOf(who) {
    if (!who || !who.id) return null;
    try {
        if (who.type === 'partner') {
            const { data } = await supabase.from('persons').select('full_name, email, phone_number').eq('id', who.id).maybeSingle();
            if (data && data.email) return { name: data.full_name || '', email: data.email, phone: data.phone_number || '' };
        } else if (who.type === 'staff') {
            const { data } = await supabase.from('app_users').select('first_name, last_name, email').eq('userid', who.id).maybeSingle();
            if (data && data.email) return { name: `${data.first_name || ''} ${data.last_name || ''}`.trim(), email: data.email, phone: '' };
        }
    } catch (_) { /* ignore */ }
    return null;
}

// Send an email via platform Postmark (best-effort). Reads the token/From from
// Vercel env first, then the Secret Dungeon config (app_config), matching
// whitelabel.js. Returns {ok,error}.
async function sendMailPostmark(to, subject, htmlBody, textBody) {
    if (!to) return { ok: false, error: 'no recipient' };
    const token = process.env.POSTMARK_SERVER_TOKEN || await getConfigValue('POSTMARK_SERVER_TOKEN');
    const from = process.env.EMAIL_FROM || await getConfigValue('EMAIL_FROM') || 'noreply@mypayprotec.com';
    if (!token) return { ok: false, error: 'Postmark not configured (add POSTMARK_SERVER_TOKEN in Secret Dungeon).' };
    try {
        const { ServerClient } = await import('postmark');
        const client = new ServerClient(token);
        await client.sendEmail({ From: from, To: to, Subject: subject, HtmlBody: htmlBody, TextBody: textBody || '', MessageStream: 'outbound' });
        return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
}

// Build a stats summary (conversions-first) for a campaign, for the manual send.
async function buildStatsSummary(id) {
    const { data: c } = await supabase.from('marketing_campaigns')
        .select('title, event_mode, campaign_kind, conv_location_id, conv_form_id, conv_calendar_id, starts_at, ends_at, created_at').eq('id', id).maybeSingle();
    if (!c) return null;
    const [{ data: ev }, { count: optedIn }] = await Promise.all([
        supabase.from('marketing_events').select('event_type, user_id, user_type, target, created_at, ghl_location, site_id').eq('campaign_id', id).limit(50000),
        supabase.from('marketing_optins').select('id', { count: 'exact', head: true }).eq('campaign_id', id)
    ]);
    const rows = ev || [];
    const impressions = rows.filter(r => r.event_type === 'impression').length;
    const clicks = rows.filter(r => r.event_type === 'click').length;
    const dismissals = rows.filter(r => r.event_type === 'dismiss').length;
    const uImp = new Set(rows.filter(r => r.event_type === 'impression').map(r => r.user_id)).size;
    const uClick = new Set(rows.filter(r => r.event_type === 'click').map(r => r.user_id)).size;
    const ctr = uImp ? Math.round((uClick / uImp) * 1000) / 10 : 0;

    // Clicks by channel (partner/staff/prospect/ghl/website).
    const byAudience = { partner: 0, staff: 0, prospect: 0, ghl: 0, website: 0 };
    rows.filter(r => r.event_type === 'click').forEach(r => {
        let ch = 'website';
        if (r.user_type === 'partner') ch = 'partner';
        else if (r.user_type === 'staff') ch = 'staff';
        else if (r.user_type === 'lead') ch = 'prospect';
        else if (r.ghl_location) ch = 'ghl';
        if (byAudience[ch] != null) byAudience[ch]++;
    });
    // Clicks by button / hotspot target.
    const byTarget = {};
    rows.filter(r => r.event_type === 'click').forEach(r => { const k = r.target || 'cta'; byTarget[k] = (byTarget[k] || 0) + 1; });

    // YouTube lifecycle breakdown (upcoming/live/replay), same logic as get_stats.
    let byPhase = null;
    const em = c.event_mode;
    if (em && em.enabled && (em.live_at || em.live_until)) {
        const liveAt = em.live_at ? new Date(em.live_at).getTime() : null;
        const liveUntil = em.live_until ? new Date(em.live_until).getTime() : null;
        const phaseAt = (ts) => {
            const t = new Date(ts).getTime();
            if (liveAt && t < liveAt) return 'upcoming';
            if ((!liveAt || t >= liveAt) && (!liveUntil || t <= liveUntil)) return 'live';
            return 'replay';
        };
        const mk = () => ({ impressions: 0, clicks: 0, _i: new Set(), _c: new Set() });
        const b = { upcoming: mk(), live: mk(), replay: mk() };
        rows.forEach(r => {
            const k = b[phaseAt(r.created_at)]; if (!k) return;
            if (r.event_type === 'impression') { k.impressions++; if (r.user_id) k._i.add(r.user_id); }
            else if (r.event_type === 'click') { k.clicks++; if (r.user_id) k._c.add(r.user_id); }
        });
        const fin = x => ({ impressions: x.impressions, clicks: x.clicks, ctr: x._i.size ? Math.round((x._c.size / x._i.size) * 1000) / 10 : 0 });
        byPhase = { upcoming: fin(b.upcoming), live: fin(b.live), replay: fin(b.replay) };
    }

    let conv = null;
    if (c.conv_location_id && (c.conv_form_id || c.conv_calendar_id)) {
        try {
            const list = await convFetch(c);
            const partners = await convEnrichPartners(list, c.conv_location_id, 150);
            const byType = {};
            list.forEach(x => { byType[x.type] = (byType[x.type] || 0) + 1; });
            const convRate = clicks ? Math.round((list.length / clicks) * 1000) / 10 : null;
            conv = { total: list.length, partners, non_partners: list.length - partners, by_type: byType, rate: convRate, list: list.slice(0, 50) };
            recordOptins(supabase, id, list, 'ghl_sync').catch(() => {});
        } catch (_) { conv = { total: 0, partners: 0, non_partners: 0, by_type: {}, rate: null, list: [] }; }
    }
    return {
        title: c.title || 'Announcement', is_youtube: !!(c.campaign_kind === 'youtube' || (em && em.enabled)),
        impressions, clicks, dismissals, unique_impressions: uImp, unique_clicks: uClick, ctr,
        opted_in: optedIn || 0, by_audience: byAudience, by_target: byTarget, by_phase: byPhase,
        window: em ? { opt_in_until: em.opt_in_until || null, live_at: em.live_at || null, live_until: em.live_until || null } : null,
        starts_at: c.starts_at || null, ends_at: c.ends_at || null, conversions: conv
    };
}

// Render the stats summary → a detailed HTML email (conversions emphasized).
function statsEmailHtml(s) {
    const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmtDate = iso => { if (!iso) return '—'; try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); } catch (_) { return String(iso); } };
    const tile = (n, l, color, bg) => `<td style="padding:12px 14px;text-align:center;border:1px solid #e2e8f0;border-radius:10px;background:${bg || '#ffffff'};"><div style="font-size:24px;font-weight:800;color:${color || '#0a1628'};font-family:monospace;">${esc(n)}</div><div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-top:2px;">${esc(l)}</div></td>`;
    const h3 = (t, color) => `<h3 style="margin:24px 0 8px;font-size:14px;color:${color || '#0a1628'};border-bottom:2px solid #eef2f7;padding-bottom:6px;">${t}</h3>`;
    const conv = s.conversions;

    // ── Conversions (highlighted) ──
    let convBlock = '';
    if (conv) {
        const bt = conv.by_type || {};
        convBlock = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:16px;margin-top:8px;">
            <div style="font-size:14px;font-weight:800;color:#16a34a;margin-bottom:10px;">✅ Conversions${conv.rate != null ? ` <span style="font-weight:600;color:#15803d;">· ${conv.rate}% of clicks converted</span>` : ''}</div>
            <table style="width:100%;border-collapse:separate;border-spacing:8px;"><tr>
              ${tile(conv.total, 'Total', '#16a34a', '#ffffff')}
              ${tile(conv.partners || 0, 'Current partners', '#92400e', '#ffffff')}
              ${tile(conv.non_partners != null ? conv.non_partners : (conv.total - (conv.partners || 0)), 'New / non-partner', '#0a1628', '#ffffff')}
              ${tile(bt.appointment || 0, 'Booked', '#0a1628', '#ffffff')}
            </tr></table>`;
        if (conv.list && conv.list.length) {
            convBlock += `<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:12px;background:#fff;border-radius:8px;overflow:hidden;">
              <tr style="text-align:left;color:#64748b;background:#f8fafc;"><th style="padding:6px 8px;">Name</th><th style="padding:6px 8px;">Email</th><th style="padding:6px 8px;">Type</th><th style="padding:6px 8px;">When</th></tr>
              ${conv.list.slice(0, 30).map(r => `<tr><td style="padding:6px 8px;border-top:1px solid #f1f5f9;">${esc(r.name || '')}</td><td style="padding:6px 8px;border-top:1px solid #f1f5f9;">${esc(r.email || '')}</td><td style="padding:6px 8px;border-top:1px solid #f1f5f9;">${esc(r.type || '')}</td><td style="padding:6px 8px;border-top:1px solid #f1f5f9;color:#94a3b8;">${r.at ? fmtDate(r.at) : ''}</td></tr>`).join('')}
            </table>${conv.total > 30 ? `<div style="font-size:11px;color:#94a3b8;margin-top:6px;">…and ${conv.total - 30} more.</div>` : ''}`;
        } else {
            convBlock += `<div style="font-size:12px;color:#94a3b8;margin-top:8px;">No conversions in this campaign window yet.</div>`;
        }
        convBlock += `</div>`;
    } else {
        convBlock = `<div style="font-size:12px;color:#94a3b8;margin-top:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px;">No conversion tracking configured for this campaign.</div>`;
    }

    // ── Clicks by channel ──
    const a = s.by_audience || {};
    const chanRow = (l, n, color) => `<tr><td style="padding:5px 8px;font-size:12px;color:#334155;">${esc(l)}</td><td style="padding:5px 8px;font-size:12px;font-weight:700;text-align:right;color:${color || '#0a1628'};">${esc(n || 0)}</td></tr>`;
    const channelBlock = `<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;">
        ${chanRow('🤝 Partners', a.partner, '#004990')}
        ${chanRow('🧑‍💼 Staff', a.staff)}
        ${chanRow('🔎 Prospects', a.prospect)}
        ${chanRow('🌐 GoHighLevel', a.ghl)}
        ${chanRow('💻 Website', a.website)}
      </table>`;

    // ── Clicks by button / hotspot ──
    const bt2 = s.by_target || {};
    const targetKeys = Object.keys(bt2);
    const targetBlock = targetKeys.length
        ? `<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:8px;margin-top:10px;">${targetKeys.map(k => chanRow(k, bt2[k])).join('')}</table>`
        : '';

    // ── YouTube lifecycle breakdown ──
    let phaseBlock = '';
    if (s.by_phase) {
        const w = s.window || {};
        const p = (key, label, color, when) => {
            const x = s.by_phase[key] || { impressions: 0, clicks: 0, ctr: 0 };
            return `<td style="padding:12px;border:1px solid #e2e8f0;border-top:3px solid ${color};border-radius:10px;vertical-align:top;">
                <div style="font-weight:800;color:${color};font-size:12px;margin-bottom:6px;">${label}</div>
                <div style="font-size:12px;color:#334155;">${x.impressions} views · ${x.clicks} clicks</div>
                <div style="font-size:16px;font-weight:800;color:#16a34a;font-family:monospace;margin-top:2px;">${x.ctr}% CTR</div>
                <div style="font-size:10.5px;color:#94a3b8;margin-top:6px;">${esc(when)}</div>
            </td>`;
        };
        phaseBlock = h3('📺 YouTube lifecycle', '#6d28d9') +
            `<table style="width:100%;border-collapse:separate;border-spacing:8px;"><tr>
              ${p('upcoming', 'Upcoming', '#0369a1', w.opt_in_until ? ('opt-in until ' + fmtDate(w.opt_in_until)) : ('before ' + fmtDate(w.live_at)))}
              ${p('live', 'Live', '#dc2626', fmtDate(w.live_at) + ' → ' + (w.live_until ? fmtDate(w.live_until) : 'end'))}
              ${p('replay', 'Replay', '#6d28d9', w.live_until ? ('after ' + fmtDate(w.live_until)) : 'after the event')}
            </tr></table>
            <div style="font-size:10.5px;color:#94a3b8;margin-top:4px;">Times in America/New_York.</div>`;
    }

    const windowLine = (s.starts_at || s.ends_at)
        ? `<div style="font-size:12px;color:#64748b;margin-bottom:16px;">Campaign window: ${fmtDate(s.starts_at)} → ${s.ends_at ? fmtDate(s.ends_at) : 'ongoing'}</div>`
        : '';

    return `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:auto;padding:28px;color:#1e293b;background:#ffffff;">
        <h2 style="color:#004990;margin:0 0 4px;">PayProTec — Campaign Stats</h2>
        <div style="font-size:16px;font-weight:800;margin-bottom:4px;">${esc(s.title)}${s.is_youtube ? ' <span style="font-size:11px;font-weight:700;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;border-radius:99px;padding:1px 8px;vertical-align:middle;">YouTube</span>' : ''}</div>
        ${windowLine}
        ${convBlock}
        ${h3('Engagement')}
        <table style="width:100%;border-collapse:separate;border-spacing:8px;"><tr>
          ${tile(s.impressions, 'Views')}
          ${tile(s.clicks, 'Clicks')}
          ${tile(s.ctr + '%', 'CTR (unique)', '#16a34a')}
          ${tile(s.dismissals, 'Dismissed')}
        </tr></table>
        <div style="font-size:12px;color:#64748b;margin-top:8px;">${s.unique_impressions} unique viewers · ${s.unique_clicks} unique clickers · ${s.opted_in} registered (suppressed for them)</div>
        ${h3('Clicks by channel')}
        ${channelBlock}
        ${targetKeys.length ? h3('Clicks by button / hotspot') + targetBlock : ''}
        ${phaseBlock}
        <div style="font-size:11px;color:#94a3b8;margin-top:24px;border-top:1px solid #e2e8f0;padding-top:12px;">Sent from the PayProTec marketing dashboard.</div>
    </div>`;
}

// ── Conversions (GHL) helpers, shared by get_conversions / export / dashboard ──
const PARTNER_TAG = 'ppt partner';
async function convFetch(c) {
    const startMs = c.starts_at ? new Date(c.starts_at).getTime() : (c.created_at ? new Date(c.created_at).getTime() : Date.now() - 90 * 864e5);
    const endMs = c.ends_at ? Math.min(new Date(c.ends_at).getTime(), Date.now()) : Date.now();
    const [forms, appts] = await Promise.all([
        ghlFormSubmissions(c.conv_location_id, c.conv_form_id, startMs, endMs),
        ghlCalendarAppointments(c.conv_location_id, c.conv_calendar_id, startMs, endMs)
    ]);
    return [...(forms || []), ...(appts || [])].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}
// Mark signups whose HighLevel contact carries the "ppt partner" tag (bounded).
async function convEnrichPartners(list, locationId, cap) {
    const withId = list.filter(x => x.contact_id).slice(0, cap || 150);
    for (let i = 0; i < withId.length; i += 8) {
        const batch = withId.slice(i, i + 8);
        await Promise.all(batch.map(async x => {
            const info = await ghlContactInfo(locationId, x.contact_id);
            x.is_partner = info.tags.some(t => t.indexOf(PARTNER_TAG) !== -1);
            x.page = info.page || '';       // which page they opted in on
            x.source = info.source || '';
        }));
    }
    return list.filter(x => x.is_partner).length;
}

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
        mode: s.contact.mode === 'ghl_form' ? 'ghl_form' : 'native',
        name: !!s.contact.name, email: !!s.contact.email, phone: !!s.contact.phone,
        required: Array.isArray(s.contact.required) ? s.contact.required.filter(f => ['name', 'email', 'phone'].includes(f)) : [],
        // GHL integration (both modes may target a sub-account).
        ghl_location_id: str(s.contact.ghl_location_id, 100) || null,
        ghl_form_id: str(s.contact.ghl_form_id, 100) || null,
        ghl_form_name: str(s.contact.ghl_form_name, 200) || null,
        ghl_tags: Array.isArray(s.contact.ghl_tags) ? s.contact.ghl_tags.map(t => str(t, 80)).filter(Boolean).slice(0, 20) : [],
        push: !!s.contact.push
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

// Normalize the popup visual theme (all optional; renderers fall back to defaults).
function normalizeTheme(t) {
    if (!t || typeof t !== 'object') return null;
    const col = (v, d) => (/^#[0-9a-fA-F]{3,8}$/.test(String(v || '')) ? String(v) : d);
    const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
    const out = {
        bg: col(t.bg, '#ffffff'),
        text: col(t.text, '#475569'),
        title: col(t.title, '#0f172a'),
        accent: col(t.accent, '#004990'),
        btnText: col(t.btnText, '#ffffff'),
        radius: Math.max(0, Math.min(40, parseInt(t.radius, 10) || 16)),
        width: pick(t.width, ['narrow', 'normal', 'wide', 'xwide'], 'normal'),
        align: pick(t.align, ['left', 'center'], 'left'),
        btnStyle: pick(t.btnStyle, ['solid', 'outline', 'pill'], 'solid'),
        btnSize: pick(t.btnSize, ['sm', 'md', 'lg'], 'md'),
        btnAlign: pick(t.btnAlign, ['left', 'center', 'right', 'full'], 'full'),
        imgPos: pick(t.imgPos, ['top', 'bottom'], 'top'),
        overlay: pick(t.overlay, ['dark', 'light'], 'dark')
    };
    return out;
}

const ADMIN_ACTIONS = new Set([
    'list_campaigns', 'get_campaign', 'create_campaign', 'update_campaign',
    'delete_campaign', 'toggle_active', 'get_upload_url', 'get_stats', 'can_access',
    'search_partners', 'export_clicks', 'partners_by_ids',
    'list_sites', 'create_site', 'toggle_site', 'delete_site', 'site_pages', 'set_site_excluded', 'campaign_pages', 'ghl_locations',
    'get_responses', 'export_responses', 'dashboard', 'referrals_report', 'referral_link',
    'webflow_status', 'webflow_authorize_url', 'webflow_sync', 'webflow_wire', 'webflow_unwire', 'webflow_disconnect',
    'get_pixels', 'set_pixels', 'export_audience',
    'ghl_forms', 'ghl_tags', 'ghl_calendars', 'ghl_workflows', 'get_conversions', 'export_conversions', 'scan_cta', 'sync_optins', 'staff_recipients', 'send_stats',
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
                .select('role, access_marketing, access_marketing_settings, email, first_name, last_name').eq('userid', session.userid).maybeSingle();
            const canAccess = !!caller && (caller.role === 'super_admin' || caller.role === 'admin' || caller.access_marketing === true);
            if (action === 'can_access') return ok(res, { can_access: canAccess, role: caller?.role || null });
            if (!canAccess) return bad(res, 'You do not have access to Marketing.', 403);
            const actorName = caller ? `${caller.first_name || ''} ${caller.last_name || ''}`.trim() : session.userid;
            const actorEmail = caller?.email || session.userid;
            const log = (fields) => logActivity({ email: actorEmail, category: 'marketing', ...fields }, req);

            if (action === 'list_campaigns') {
                const { data } = await supabase.from('marketing_campaigns').select('*')
                    .order('created_at', { ascending: false });
                // attach quick counts — aggregate in the DB (counting in JS would be
                // capped at the 1000-row fetch limit and drop newer campaigns' events).
                const ids = (data || []).map(c => c.id);
                const stats = {};
                if (ids.length) {
                    const { data: rows } = await supabase.rpc('marketing_list_counts', { camp_ids: ids });
                    (rows || []).forEach(r => { stats[r.campaign_id] = { impression: Number(r.impressions) || 0, click: Number(r.clicks) || 0, dismiss: Number(r.dismissals) || 0 }; });
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
                // Trim + cap a string field (used by the event-mode phase labels below).
                const str = (v, n) => (v == null ? '' : String(v)).slice(0, n);
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
                    audience: ['partner', 'staff', 'both', 'prospect', 'all'].includes(b.audience) ? b.audience : 'partner',
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
                    // External-site capture format + trigger.
                    embed_format: ['modal', 'bar', 'slide'].includes(b.embed_format) ? b.embed_format : 'modal',
                    embed_trigger: ['load', 'delay', 'exit'].includes(b.embed_trigger) ? b.embed_trigger : 'load',
                    embed_delay: Number.isFinite(+b.embed_delay) ? Math.min(120, Math.max(0, Math.round(+b.embed_delay))) : 5,
                    // Popup visual design.
                    theme: normalizeTheme(b.theme),
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
                    // "When clicked → trigger a HighLevel workflow" (portal + identified embed clicks).
                    click_workflow: (b.click_workflow && b.click_workflow.enabled && b.click_workflow.location_id)
                        ? {
                            enabled: true,
                            location_id: String(b.click_workflow.location_id).trim(),
                            workflow_id: b.click_workflow.workflow_id ? String(b.click_workflow.workflow_id).trim() : null,
                            workflow_name: b.click_workflow.workflow_name ? String(b.click_workflow.workflow_name).slice(0, 200) : null,
                            tags: Array.isArray(b.click_workflow.tags) ? b.click_workflow.tags.map(t => String(t).slice(0, 80)).filter(Boolean).slice(0, 20) : []
                        }
                        : {},
                    // CTA opt-in gate (external sites only): a HighLevel form shown before
                    // the CTA link (e.g. a YouTube live). Submissions become conversions.
                    cta_gate: (b.cta_gate && b.cta_gate.enabled && b.cta_gate.form_id)
                        ? { enabled: true, form_id: String(b.cta_gate.form_id).trim(), location_id: b.cta_gate.location_id ? String(b.cta_gate.location_id).trim() : null, until: b.cta_gate.until || null }
                        : null,
                    is_active: !!b.is_active,
                    // 3-phase event mode (gated → live → replay), driven by dates.
                    campaign_kind: b.campaign_kind === 'youtube' ? 'youtube' : 'classic',
                    event_mode: (b.event_mode && b.event_mode.enabled && (b.event_mode.live_at || b.event_mode.live_until)) ? {
                        enabled: true,
                        opt_in_until: b.event_mode.opt_in_until || null,
                        live_at: b.event_mode.live_at || null,
                        live_until: b.event_mode.live_until || null,
                        pre_label: str(b.event_mode.pre_label, 60) || null, pre_url: str(b.event_mode.pre_url, 1000) || null, pre_headline: str(b.event_mode.pre_headline, 160) || null,
                        closed_label: str(b.event_mode.closed_label, 60) || null, closed_url: str(b.event_mode.closed_url, 1000) || null, closed_headline: str(b.event_mode.closed_headline, 160) || null,
                        live_label: str(b.event_mode.live_label, 60) || null, live_url: str(b.event_mode.live_url, 1000) || null, live_headline: str(b.event_mode.live_headline, 160) || null, live_body: str(b.event_mode.live_body, 2000) || null,
                        replay_label: str(b.event_mode.replay_label, 60) || null, replay_url: str(b.event_mode.replay_url, 1000) || null, replay_headline: str(b.event_mode.replay_headline, 160) || null, replay_body: str(b.event_mode.replay_body, 2000) || null
                    } : {},
                    starts_at: b.starts_at || null,
                    ends_at: b.ends_at || null,
                    priority: Number.isFinite(+b.priority) ? +b.priority : 0,
                    updated_at: new Date().toISOString()
                };
                // Auto-wire conversions to the gate form so submissions are counted
                // as conversions (unless a conversion form was set explicitly).
                if (rec.cta_gate && rec.cta_gate.form_id) {
                    if (!rec.conv_form_id) rec.conv_form_id = rec.cta_gate.form_id;
                    if (!rec.conv_location_id && rec.cta_gate.location_id) rec.conv_location_id = rec.cta_gate.location_id;
                }
                let row;
                if (action === 'update_campaign') {
                    if (!b.id) return bad(res, 'id required');
                    const { data, error } = await supabase.from('marketing_campaigns').update(rec).eq('id', b.id).select().single();
                    if (error) return bad(res, error.message);
                    row = data;
                    log({ action: `${actorName} updated campaign "${row.title || b.id}"`, target_type: 'marketing_campaign', target_id: row.id });
                } else {
                    rec.created_by = actorName;
                    const { data, error } = await supabase.from('marketing_campaigns').insert(rec).select().single();
                    if (error) return bad(res, error.message);
                    row = data;
                    log({ action: `${actorName} created campaign "${row.title || ''}"`, target_type: 'marketing_campaign', target_id: row.id });
                }
                return ok(res, row);
            }

            if (action === 'toggle_active') {
                const { id, is_active } = req.body;
                const { data, error } = await supabase.from('marketing_campaigns')
                    .update({ is_active: !!is_active, updated_at: new Date().toISOString() }).eq('id', id).select().single();
                if (error) return bad(res, error.message);
                log({ action: `${actorName} ${is_active ? 'activated' : 'paused'} campaign "${data?.title || id}"`, target_type: 'marketing_campaign', target_id: id });
                return ok(res, data);
            }

            if (action === 'delete_campaign') {
                const { id } = req.body;
                const { data: existing } = await supabase.from('marketing_campaigns').select('title').eq('id', id).maybeSingle();
                const { error } = await supabase.from('marketing_campaigns').delete().eq('id', id);
                if (error) return bad(res, error.message);
                log({ action: `${actorName} deleted campaign "${existing?.title || id}"`, severity: 'warning', target_type: 'marketing_campaign', target_id: id });
                return ok(res, { deleted: true });
            }

            if (action === 'get_stats') {
                const { id } = req.body;
                const [{ data: ev }, { data: campRow }, { count: optedInCount }] = await Promise.all([
                    supabase.from('marketing_events')
                        .select('event_type, user_id, user_type, target, created_at, variant, site_id, ghl_location, meta, country').eq('campaign_id', id).limit(50000),
                    supabase.from('marketing_campaigns').select('event_mode, campaign_kind').eq('id', id).maybeSingle(),
                    supabase.from('marketing_optins').select('id', { count: 'exact', head: true }).eq('campaign_id', id)
                ]);
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
                const leadIds = [...new Set(rows.filter(r => r.user_type === 'lead').map(r => r.user_id).filter(Boolean))];
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
                if (leadIds.length) {
                    const { data: ld } = await supabase.from('leads').select('id, full_name, email').in('id', leadIds);
                    (ld || []).forEach(l => { nameMap['lead:' + l.id] = l.full_name || l.email || 'Lead'; });
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
                    if (r.user_type === 'lead') return { name: nameMap['lead:' + r.user_id] || 'Prospect', channel: 'prospect', source: 'Lead Portal (Prospect)' };
                    // embed viewer (external site / GHL)
                    const email = String(r.user_id || '').indexOf('email:') === 0 ? String(r.user_id).slice(6) : '';
                    if (r.ghl_location) {
                        const acct = locNames[r.ghl_location] || 'GoHighLevel sub-account';
                        return { name: email || acct, channel: 'ghl', source: acct };
                    }
                    const site = r.site_id ? (siteNames[r.site_id] || 'Website') : 'Website';
                    return { name: email || 'Website visitor', channel: 'website', source: site };
                };

                const byAudience = { partner: 0, staff: 0, prospect: 0, ghl: 0, website: 0 };
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

                // ── YouTube lifecycle breakdown: upcoming / live / replay ─────────
                // Each tracked event is bucketed by the phase it happened in, using
                // the SAME date logic as api/embed.js (created_at vs the event_mode
                // dates). 'closed' (opt-in shut, before live) folds into 'upcoming'.
                let byPhase = null;
                const em = campRow && campRow.event_mode;
                if (em && em.enabled && (em.live_at || em.live_until)) {
                    const liveAt = em.live_at ? new Date(em.live_at).getTime() : null;
                    const liveUntil = em.live_until ? new Date(em.live_until).getTime() : null;
                    const phaseAt = (ts) => {
                        const t = new Date(ts).getTime();
                        if (liveAt && t < liveAt) return 'upcoming';                 // opt-in + closed
                        if ((!liveAt || t >= liveAt) && (!liveUntil || t <= liveUntil)) return 'live';
                        return 'replay';
                    };
                    const mk = () => ({ impressions: 0, clicks: 0, dismissals: 0, _impU: new Set(), _clkU: new Set() });
                    const buckets = { upcoming: mk(), live: mk(), replay: mk() };
                    rows.forEach(r => {
                        const b = buckets[phaseAt(r.created_at)]; if (!b) return;
                        if (r.event_type === 'impression') { b.impressions++; if (r.user_id) b._impU.add(r.user_id); }
                        else if (r.event_type === 'click') { b.clicks++; if (r.user_id) b._clkU.add(r.user_id); }
                        else if (r.event_type === 'dismiss') { b.dismissals++; }
                    });
                    const finalize = (b) => {
                        const ui = b._impU.size, uc = b._clkU.size;
                        return { impressions: b.impressions, clicks: b.clicks, dismissals: b.dismissals,
                            unique_impressions: ui, unique_clicks: uc, ctr: ui ? Math.round((uc / ui) * 1000) / 10 : 0 };
                    };
                    byPhase = {
                        upcoming: finalize(buckets.upcoming),
                        live: finalize(buckets.live),
                        replay: finalize(buckets.replay),
                        window: { opt_in_until: em.opt_in_until || null, live_at: em.live_at || null, live_until: em.live_until || null }
                    };
                }

                return ok(res, {
                    impressions, clicks, dismissals,
                    unique_impressions: uImp, unique_clicks: uClick,
                    ctr: uImp ? Math.round((uClick / uImp) * 1000) / 10 : 0,   // % of unique viewers who clicked
                    clicks_by_target: byTarget, clicks_by_audience: byAudience,
                    clickers: peopleFor('click'),
                    viewers: peopleFor('impression'),
                    dismissers: peopleFor('dismiss'),
                    ab: hasAb ? { A: abFor('A'), B: abFor('B') } : null,
                    by_phase: byPhase,
                    opted_in: optedInCount || 0,   // people who registered → announcement suppressed for them
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
                log({ action: `${actorName} created marketing site "${name}"`, target_type: 'marketing_site', target_id: data.id });
                return ok(res, data);
            }
            if (action === 'toggle_site') {
                const { id, is_active } = req.body;
                const { data, error } = await supabase.from('marketing_sites').update({ is_active: !!is_active }).eq('id', id).select().single();
                if (error) return bad(res, error.message);
                log({ action: `${actorName} ${is_active ? 'enabled' : 'disabled'} marketing site "${data?.name || id}"`, target_type: 'marketing_site', target_id: id });
                return ok(res, data);
            }
            if (action === 'delete_site') {
                const { error } = await supabase.from('marketing_sites').delete().eq('id', req.body.id);
                if (error) return bad(res, error.message);
                log({ action: `${actorName} deleted a marketing site`, severity: 'warning', target_type: 'marketing_site', target_id: req.body.id });
                return ok(res, { deleted: true });
            }
            // Referral report: leads captured per partner + published landing pages.
            if (action === 'referrals_report') {
                const { data: subs } = await supabase.from('landing_submissions')
                    .select('referred_by, created_at').not('referred_by', 'is', null).limit(50000);
                const tally = {};
                (subs || []).forEach(s => { tally[s.referred_by] = (tally[s.referred_by] || 0) + 1; });
                const ids = Object.keys(tally);
                let names = {};
                if (ids.length) {
                    const { data: ppl } = await supabase.from('persons').select('id, full_name, email, referral_code').in('id', ids);
                    (ppl || []).forEach(p => { names[p.id] = p; });
                }
                const leaders = ids.map(id => ({ id, leads: tally[id], name: names[id]?.full_name || 'Partner', email: names[id]?.email || '', code: names[id]?.referral_code || '' }))
                    .sort((a, b) => b.leads - a.leads).slice(0, 100);
                const { data: pages } = await supabase.from('landing_pages').select('slug, title').eq('is_published', true).order('title');
                return ok(res, { leaders, total: (subs || []).length, pages: pages || [] });
            }
            // A partner's referral code (search by name/email) for building their link.
            if (action === 'referral_link') {
                const q = String(req.body.q || '').trim();
                if (q.length < 2) return ok(res, { partners: [] });
                const like = `%${q}%`;
                const { data } = await supabase.from('persons')
                    .select('id, full_name, email, referral_code')
                    .or(`full_name.ilike.${like},email.ilike.${like}`).limit(15);
                // Ensure a code exists for each match.
                for (const p of (data || [])) {
                    if (!p.referral_code) {
                        const code = String(p.id).replace(/-/g, '').slice(0, 8);
                        await supabase.from('persons').update({ referral_code: code }).eq('id', p.id);
                        p.referral_code = code;
                    }
                }
                return ok(res, { partners: (data || []).map(p => ({ id: p.id, name: p.full_name, email: p.email, code: p.referral_code })) });
            }
            // Aggregate performance dashboard across all campaigns.
            if (action === 'dashboard') {
                const days = 30;
                const sinceIso = new Date(Date.now() - days * 864e5).toISOString();
                const [{ data: camps }, { data: agg }, { count: leadCount }] = await Promise.all([
                    supabase.from('marketing_campaigns').select('id, title, is_active, conv_location_id, conv_form_id, conv_calendar_id, starts_at, ends_at, created_at'),
                    // Aggregate events in the DB (JS counting would be capped at 1000 rows).
                    supabase.rpc('marketing_dashboard', { since: sinceIso }),
                    supabase.from('marketing_responses').select('id', { count: 'exact', head: true }).or('email.not.is.null,phone.not.is.null')
                ]);
                const A = agg || {};
                // Aggregate GHL conversions + partner split across conversion-tracked
                // campaigns (bounded so the dashboard stays fast).
                let convTotal = 0, convPartners = 0, partnerBudget = 150;
                const convByCampaign = [];
                const convCamps = (camps || []).filter(c => c.conv_location_id && (c.conv_form_id || c.conv_calendar_id)).slice(0, 20);
                for (const c of convCamps) {
                    try {
                        const list = await convFetch(c);
                        let p = 0;
                        if (partnerBudget > 0) { const cap = Math.min(partnerBudget, list.length); p = await convEnrichPartners(list, c.conv_location_id, cap); partnerBudget -= cap; }
                        convTotal += list.length; convPartners += p;
                        if (list.length) convByCampaign.push({ id: c.id, title: c.title, total: list.length, partners: p });
                    } catch (e) { /* skip a campaign that errors */ }
                }
                convByCampaign.sort((a, b) => b.total - a.total);
                const titleOf = {}; (camps || []).forEach(c => { titleOf[c.id] = c.title; });
                const T = A.totals || { impressions: 0, clicks: 0, dismissals: 0 };
                const imp = Number(T.impressions) || 0, clk = Number(T.clicks) || 0, dis = Number(T.dismissals) || 0;
                const ch = A.channel || {};
                const channel = { partner: Number(ch.partner) || 0, staff: Number(ch.staff) || 0, prospect: Number(ch.prospect) || 0, ghl: Number(ch.ghl) || 0, website: Number(ch.website) || 0 };
                const top = (A.per_campaign || [])
                    .map(v => ({ id: v.campaign_id, title: titleOf[v.campaign_id] || '(deleted)', impressions: Number(v.impressions) || 0, clicks: Number(v.clicks) || 0, ctr: v.impressions ? Math.round(v.clicks / v.impressions * 1000) / 10 : 0 }))
                    .sort((a, b) => b.clicks - a.clicks).slice(0, 10);
                const trendMap = {}; (A.trend || []).forEach(r => { trendMap[r.day] = { imp: Number(r.imp) || 0, clk: Number(r.clk) || 0 }; });
                const trendArr = [];
                for (let i = days - 1; i >= 0; i--) {
                    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
                    trendArr.push({ day: d, imp: (trendMap[d] || {}).imp || 0, clk: (trendMap[d] || {}).clk || 0 });
                }
                return ok(res, {
                    window_days: days,
                    totals: { campaigns: (camps || []).length, active: (camps || []).filter(c => c.is_active).length, impressions: imp, clicks: clk, dismissals: dis, ctr: imp ? Math.round(clk / imp * 1000) / 10 : 0, leads: leadCount || 0 },
                    conversions: { total: convTotal, partners: convPartners, non_partners: Math.max(0, convTotal - convPartners), by_campaign: convByCampaign },
                    channel, top, trend: trendArr
                });
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
            if (action === 'ghl_tags') {
                const { location_id } = req.body;
                if (!location_id) return bad(res, 'location_id required');
                return ok(res, await ghlListTags(location_id));
            }
            if (action === 'ghl_forms') {
                if (!req.body.location_id) return ok(res, []);
                return ok(res, await ghlListForms(req.body.location_id));
            }
            if (action === 'ghl_calendars') {
                if (!req.body.location_id) return ok(res, []);
                return ok(res, await ghlListCalendars(req.body.location_id));
            }
            if (action === 'ghl_workflows') {
                if (!req.body.location_id) return ok(res, []);
                return ok(res, await ghlListWorkflows(req.body.location_id));
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
                const list = await convFetch(c);
                // Authoritatively backfill the opt-in registry from GHL so registered
                // people stay suppressed even if their browser never fired a dismiss.
                recordOptins(supabase, id, list, 'ghl_sync').catch(() => {});
                const partners = await convEnrichPartners(list, c.conv_location_id, 150);
                const byType = {};
                list.forEach(x => { byType[x.type] = (byType[x.type] || 0) + 1; });
                return ok(res, { configured: true, count: list.length, partners, non_partners: list.length - partners, by_type: byType, list: list.slice(0, 100) });
            }
            // CSV export of a campaign's conversions, incl. a current-partner column.
            if (action === 'export_conversions') {
                const { id } = req.body;
                const { data: c } = await supabase.from('marketing_campaigns')
                    .select('conv_location_id, conv_form_id, conv_calendar_id, starts_at, ends_at, created_at').eq('id', id).maybeSingle();
                if (!c || !c.conv_location_id || (!c.conv_form_id && !c.conv_calendar_id)) return ok(res, { csv: 'type,name,email,phone,current_partner,at\n' });
                const list = await convFetch(c);
                await convEnrichPartners(list, c.conv_location_id, 500);
                const esc = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
                const header = 'type,name,email,phone,current_partner,opt_in_page,source,at';
                const csv = [header].concat(list.map(r => [r.type, r.name, r.email, r.phone, r.is_partner ? 'yes' : 'no', r.page || '', r.source || '', r.at].map(esc).join(','))).join('\n');
                return ok(res, { csv });
            }

            // Manually backfill the opt-in registry from GHL for one campaign (or all
            // conversion-wired campaigns). Registered people are then suppressed
            // everywhere they're identified, across devices.
            if (action === 'sync_optins') {
                const { id } = req.body;
                let camps = [];
                if (id) {
                    const { data: c } = await supabase.from('marketing_campaigns')
                        .select('id, conv_location_id, conv_form_id, conv_calendar_id, starts_at, ends_at, created_at').eq('id', id).maybeSingle();
                    if (c) camps = [c];
                } else {
                    const { data } = await supabase.from('marketing_campaigns')
                        .select('id, conv_location_id, conv_form_id, conv_calendar_id, starts_at, ends_at, created_at')
                        .not('conv_location_id', 'is', null);
                    camps = data || [];
                }
                let total = 0, done = 0;
                for (const c of camps) { const n = await syncCampaignOptins(c); total += n; done++; }
                return ok(res, { campaigns: done, opted_in: total });
            }

            // Staff users who can receive a manually-sent stats email (picker source).
            if (action === 'staff_recipients') {
                const { data } = await supabase.from('app_users')
                    .select('userid, first_name, last_name, email, is_active')
                    .order('first_name', { ascending: true });
                const list = (data || [])
                    .filter(u => u.email && u.is_active !== false)
                    .map(u => ({ userid: u.userid, name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email, email: u.email }));
                return ok(res, list);
            }

            // Manually email a campaign's stats (conversions-first) to chosen users.
            if (action === 'send_stats') {
                const { id, user_ids, emails } = req.body;
                if (!id) return bad(res, 'campaign_id required');
                // Resolve recipient emails from selected staff ids + any free-typed emails.
                const set = new Set();
                if (Array.isArray(user_ids) && user_ids.length) {
                    const { data } = await supabase.from('app_users').select('userid, email').in('userid', user_ids.map(String));
                    (data || []).forEach(u => { if (u.email) set.add(String(u.email).trim().toLowerCase()); });
                }
                if (Array.isArray(emails)) emails.forEach(e => { const n = normEmail(e); if (n) set.add(n); });
                const recipients = [...set];
                if (!recipients.length) return bad(res, 'Pick at least one recipient.');
                const summary = await buildStatsSummary(id);
                if (!summary) return bad(res, 'Campaign not found.');
                const html = statsEmailHtml(summary);
                const subject = `📊 Campaign stats: ${summary.title}`;
                let sent = 0; const failed = [];
                for (const to of recipients) {
                    const r = await sendMailPostmark(to, subject, html, `Stats for ${summary.title}. Conversions: ${summary.conversions ? summary.conversions.total : 'n/a'}, Views: ${summary.impressions}, Clicks: ${summary.clicks}, CTR: ${summary.ctr}%.`);
                    if (r.ok) sent++; else failed.push(to);
                }
                return ok(res, { sent, failed, recipients: recipients.length });
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
                    .in('audience', [who.type, 'both', 'all'])
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

                // exclude ones this user dismissed (by id) OR opted into (by email,
                // cross-device — Option A: register once, hidden everywhere they're known).
                const ids = live.map(c => c.id);
                let dismissed = new Set();
                if (ids.length) {
                    const { data: dis } = await supabase.from('marketing_dismissals')
                        .select('campaign_id').in('campaign_id', ids).eq('user_id', who.id);
                    dismissed = new Set((dis || []).map(d => d.campaign_id));
                    const vEmail = await viewerEmailOf(who);
                    if (vEmail) {
                        const opted = await optedInIds(supabase, vEmail, ids);
                        opted.forEach(id => dismissed.add(id));
                    }
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
                    // ── YouTube lifecycle: gated (pre) → live → replay, by date ──
                    let ctaLabel = v.cta_label, ctaUrl = v.cta_url, headline = v.title, bodyText = v.body_text, eventPhase = null, videoUrl = null;
                    const em = c.event_mode;
                    if (em && em.enabled && (em.live_at || em.live_until)) {
                        const liveAt = em.live_at ? new Date(em.live_at).getTime() : null;
                        const liveUntil = em.live_until ? new Date(em.live_until).getTime() : null;
                        const optInUntil = em.opt_in_until ? new Date(em.opt_in_until).getTime() : null;
                        if (liveAt && now < liveAt && optInUntil && now >= optInUntil) {
                            eventPhase = 'closed';
                            if (em.closed_label) ctaLabel = em.closed_label;
                            ctaUrl = em.closed_url || null;
                            if (em.closed_headline) headline = em.closed_headline;
                            if (em.closed_body) bodyText = em.closed_body;
                        } else if (liveAt && now < liveAt) {
                            eventPhase = 'pre';
                            if (em.pre_label) ctaLabel = em.pre_label;
                            if (em.pre_url) ctaUrl = em.pre_url;
                            if (em.pre_headline) headline = em.pre_headline;
                            if (em.pre_body) bodyText = em.pre_body;
                        } else if ((!liveAt || now >= liveAt) && (!liveUntil || now <= liveUntil)) {
                            eventPhase = 'live';
                            if (em.live_label) ctaLabel = em.live_label;
                            if (em.live_url) ctaUrl = em.live_url;
                            if (em.live_headline) headline = em.live_headline;
                            if (em.live_body) bodyText = em.live_body;
                            videoUrl = ytEmbed(em.live_url || ctaUrl);
                        } else {
                            eventPhase = 'replay';
                            if (em.replay_label) ctaLabel = em.replay_label;
                            if (em.replay_url) ctaUrl = em.replay_url;
                            if (em.replay_headline) headline = em.replay_headline;
                            if (em.replay_body) bodyText = em.replay_body;
                            videoUrl = ytEmbed(em.replay_url || ctaUrl);
                        }
                    }
                    return {
                        id: c.id, title: headline, body_text: bodyText, image_url: v.image_url,
                        content_type: c.content_type, cta_enabled: v.cta_enabled, cta_label: ctaLabel,
                        cta_url: ctaUrl, video_url: videoUrl, hotspots: v.hotspots || [], priority: c.priority,
                        display_mode: c.display_mode || 'card_dismissible',
                        reshow_minutes: c.reshow_minutes || 5,
                        survey: c.survey || null,
                        theme: c.theme || null,
                        event_phase: eventPhase,
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
                // Register the opt-in (cross-device suppression) + mark dismissed.
                const rEmail = normEmail(email) || await viewerEmailOf(who);
                if (rEmail) {
                    await recordOptin(supabase, campaign_id, rEmail, 'survey');
                    await supabase.from('marketing_dismissals')
                        .upsert({ campaign_id, user_id: who.id, user_type: who.type }, { onConflict: 'campaign_id,user_id' }).then(() => {}, () => {});
                }
                // Push the lead to a GHL sub-account (with tags) if the campaign is configured for it.
                if (email || phone) {
                    const { data: camp } = await supabase.from('marketing_campaigns').select('survey').eq('id', campaign_id).maybeSingle();
                    const cc = camp?.survey?.contact;
                    if (cc && cc.push && cc.ghl_location_id) {
                        ghlUpsertContact(cc.ghl_location_id, { name, email, phone }, cc.ghl_tags || []).catch(() => {});
                    }
                }
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
                // Portal CTA click → trigger the campaign's HighLevel workflow (the
                // hole: portal clicks otherwise never reach GHL). Awaited so it runs
                // before the serverless function freezes; best-effort inside.
                if (event_type === 'click' && (target === 'cta' || !target)) {
                    const person = await viewerContactOf(who);
                    if (person) await fireClickWorkflow(campaign_id, person);
                }
                return ok(res, { logged: true });
            }

            if (action === 'dismiss') {
                const { campaign_id } = req.body;
                if (!campaign_id) return bad(res, 'campaign_id required');
                await supabase.from('marketing_dismissals')
                    .upsert({ campaign_id, user_id: who.id, user_type: who.type }, { onConflict: 'campaign_id,user_id' });
                await supabase.from('marketing_events').insert({ campaign_id, user_id: who.id, user_type: who.type, event_type: 'dismiss' });
                // Register the opt-in by email so it stays hidden on their other devices.
                const dEmail = normEmail(req.body?.email) || await viewerEmailOf(who);
                if (dEmail) await recordOptin(supabase, campaign_id, dEmail, 'portal');
                return ok(res, { dismissed: true });
            }
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
