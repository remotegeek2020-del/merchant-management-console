// ── PUBLIC EMBED ENDPOINT ────────────────────────────────────────────────────
// Read-only announcements feed for EXTERNAL sites (Webflow, GoHighLevel, etc.)
// loaded via /embed.js. Auth = site_key (looked up in marketing_sites). CORS is
// open so any partner site can load it; the site_key gates which requests are
// honoured and can be revoked instantly.
//
// Only three actions are exposed — get_active / track / dismiss. No admin
// surface, no stats, no other campaigns ever leave the portal here. Viewers are
// anonymous: user_type = 'embed', user_id = a caller-supplied email or an
// anonymous visitor id.

import { createClient } from '@supabase/supabase-js';
import { ghlUpsertContact } from './_ghl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
}
const ok = (res, data) => res.status(200).json({ success: true, data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

// Stable 0..99 bucket (FNV-1a) for A/B split per viewer.
function hashPct(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0) % 100;
}

// Normalize a page URL (or path) to a comparable "host/path" (or "/path") form:
// lowercase, no scheme, no www., no query/hash, no trailing slash.
export function normPage(input) {
    let s = String(input == null ? '' : input).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z]+:\/\//, '');       // drop scheme
    s = s.split('#')[0].split('?')[0];        // drop hash + query
    s = s.replace(/^www\./, '');
    if (s.length > 1) s = s.replace(/\/+$/, '');   // drop trailing slash (keep bare "/")
    return s;
}
// The path-only portion of a normalized "host/path" (leading slash kept).
function pathOf(normalized) {
    if (!normalized) return '/';
    if (normalized.charAt(0) === '/') return normalized;
    const i = normalized.indexOf('/');
    return i === -1 ? '/' : normalized.slice(i);
}
// Does the viewer's page match any excluded entry? Supports a trailing '*'
// wildcard and path-only entries (e.g. "/pricing" matches on any host).
export function pageExcluded(pageUrl, excluded) {
    if (!Array.isArray(excluded) || !excluded.length) return false;
    const hostPath = normPage(pageUrl);
    if (!hostPath) return false;
    const p = pathOf(hostPath);
    return excluded.some(raw => {
        let e = normPage(raw);
        if (!e) return false;
        const wild = e.endsWith('*');
        if (wild) e = e.slice(0, -1);
        const target = (e.charAt(0) === '/') ? p : hostPath;   // path-only entry compares against path
        return wild ? target.startsWith(e) : target === e;
    });
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const action = body?.action;
    const siteKey = body?.site_key;
    const viewer = String(body?.viewer_id || '').slice(0, 200);
    const ghlLoc = body?.ghl_location ? String(body.ghl_location).slice(0, 100) : null;
    // Coarse geo from the edge (no precise location); works on Vercel.
    const country = (req.headers['x-vercel-ip-country'] || req.headers['cf-ipcountry'] || '') || null;
    // Sanitize the client-supplied traffic context to a bounded shape.
    function cleanMeta(m) {
        if (!m || typeof m !== 'object') return null;
        const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
        const out = {
            ref: cut(m.ref, 300), url: cut(m.url, 300),
            utm_source: cut(m.utm_source, 120), utm_medium: cut(m.utm_medium, 120), utm_campaign: cut(m.utm_campaign, 120),
            device: m.device === 'mobile' ? 'mobile' : (m.device === 'desktop' ? 'desktop' : null),
            lang: cut(m.lang, 12), account: cut(m.account, 120),
            // Retargeting identifiers (for CAPI / Custom Audiences / Customer Match)
            email_sha256: /^[a-f0-9]{64}$/i.test(String(m.email_sha256 || '')) ? String(m.email_sha256).toLowerCase() : null,
            fbp: cut(m.fbp, 120), fbc: cut(m.fbc, 200), gcl_au: cut(m.gcl_au, 120),
            fbclid: cut(m.fbclid, 200), gclid: cut(m.gclid, 200), li_fat_id: cut(m.li_fat_id, 120)
        };
        return Object.values(out).some(v => v) ? out : null;
    }
    if (!action) return bad(res, 'No action');
    if (!siteKey) return bad(res, 'Missing site_key', 401);

    try {
        // Validate the site key (must exist + be active).
        const { data: site } = await supabase.from('marketing_sites')
            .select('id, is_active, excluded_paths').eq('site_key', siteKey).maybeSingle();
        if (!site || !site.is_active) return bad(res, 'Invalid or inactive site key', 403);
        const siteId = site.id;

        if (action === 'get_active') {
            if (!viewer) return ok(res, []);
            // Per-site page exclusion: if this page is on the site's exclude list,
            // show no announcements here (retargeting pixels still load below).
            if (pageExcluded(body?.page, site.excluded_paths)) {
                const { data: px0 } = await supabase.from('marketing_pixels').select('*').eq('id', 1).maybeSingle();
                const pixels0 = px0 ? {
                    fb: (px0.fb_enabled && px0.fb_pixel_id) ? px0.fb_pixel_id : null,
                    google: (px0.google_enabled && px0.google_tag_id) ? px0.google_tag_id : null,
                    linkedin: (px0.linkedin_enabled && px0.linkedin_partner_id) ? px0.linkedin_partner_id : null
                } : null;
                return res.status(200).json({ success: true, data: [], pixels: pixels0, excluded: true });
            }
            const { data: all } = await supabase.from('marketing_campaigns').select('*')
                .eq('is_active', true).eq('show_on_embed', true)
                .order('priority', { ascending: false }).order('created_at', { ascending: false });
            const now = Date.now();
            const live = (all || []).filter(c =>
                (!c.starts_at || new Date(c.starts_at).getTime() <= now) &&
                (!c.ends_at || new Date(c.ends_at).getTime() >= now) &&
                // Per-campaign page exclusion (on top of the site-wide baseline above).
                !pageExcluded(body?.page, c.excluded_paths) &&
                // Site scoping: [] = all embed sites, otherwise must include this site.
                (!Array.isArray(c.embed_site_ids) || c.embed_site_ids.length === 0 || c.embed_site_ids.map(String).includes(String(siteId))) &&
                // GHL sub-account scoping: [] = all. If set, the campaign is GHL-scoped,
                // so it only shows when the caller reports a matching location id.
                (!Array.isArray(c.ghl_location_ids) || c.ghl_location_ids.length === 0 ||
                    (ghlLoc && c.ghl_location_ids.map(String).includes(String(ghlLoc)))));

            // Exclude ones this viewer permanently dismissed.
            const ids = live.map(c => c.id);
            let dismissed = new Set();
            if (ids.length) {
                const { data: dis } = await supabase.from('marketing_dismissals')
                    .select('campaign_id').in('campaign_id', ids).eq('user_id', viewer);
                dismissed = new Set((dis || []).map(d => d.campaign_id));
            }

            const out = live.filter(c => !dismissed.has(c.id)).map(c => {
                let variant = null, v = c;
                if (c.ab_enabled) {
                    variant = hashPct(viewer + ':' + c.id) < (c.ab_split ?? 50) ? 'A' : 'B';
                    if (variant === 'B') {
                        const vb = c.variant_b || {};
                        v = { ...c,
                            title: vb.title ?? c.title, body_text: vb.body_text ?? c.body_text,
                            image_url: vb.image_url ?? c.image_url, cta_enabled: vb.cta_enabled ?? c.cta_enabled,
                            cta_label: vb.cta_label ?? c.cta_label, cta_url: vb.cta_url ?? c.cta_url,
                            hotspots: Array.isArray(vb.hotspots) ? vb.hotspots : (c.hotspots || []) };
                    }
                }
                // Behavior (dismissible | persistent | until_action) parsed from display_mode.
                const dm = c.display_mode || 'card_dismissible';
                const behavior = dm.slice(dm.indexOf('_') + 1) || 'dismissible';
                // ── 3-phase event mode: gated (pre) → live → replay, by date ──
                let ctaLabel = v.cta_label, ctaUrl = v.cta_url, headline = v.title, eventPhase = null;
                let gateActive = (c.cta_gate && c.cta_gate.enabled && c.cta_gate.form_id && (!c.cta_gate.until || Date.now() < new Date(c.cta_gate.until).getTime()));
                const em = c.event_mode;
                if (em && em.enabled && (em.live_at || em.live_until)) {
                    const nowMs = Date.now();
                    const liveAt = em.live_at ? new Date(em.live_at).getTime() : null;
                    const liveUntil = em.live_until ? new Date(em.live_until).getTime() : null;
                    if (liveAt && nowMs < liveAt) {
                        eventPhase = 'pre';                       // gated "save your spot"
                        if (em.pre_label) ctaLabel = em.pre_label;
                        if (em.pre_url) ctaUrl = em.pre_url;
                        if (em.pre_headline) headline = em.pre_headline;
                    } else if ((!liveAt || nowMs >= liveAt) && (!liveUntil || nowMs <= liveUntil)) {
                        eventPhase = 'live';                      // happening now → watch live, ungated
                        gateActive = false;
                        if (em.live_label) ctaLabel = em.live_label;
                        if (em.live_url) ctaUrl = em.live_url;
                        if (em.live_headline) headline = em.live_headline;
                    } else {
                        eventPhase = 'replay';                    // after event → watch replay, ungated
                        gateActive = false;
                        if (em.replay_label) ctaLabel = em.replay_label;
                        if (em.replay_url) ctaUrl = em.replay_url;
                        if (em.replay_headline) headline = em.replay_headline;
                    }
                }
                return {
                    id: c.id, title: headline, body_text: v.body_text, image_url: v.image_url,
                    content_type: c.content_type, cta_enabled: v.cta_enabled, cta_label: ctaLabel,
                    cta_url: ctaUrl, hotspots: v.hotspots || [], priority: c.priority,
                    behavior, reshow_minutes: c.reshow_minutes || 5, survey: c.survey || null, theme: c.theme || null,
                    embed_format: c.embed_format || 'modal', embed_trigger: c.embed_trigger || 'load', embed_delay: c.embed_delay || 5,
                    event_phase: eventPhase,
                    // Gate is dropped during live/replay (and once expired) → CTA becomes a plain link.
                    cta_gate: gateActive ? { form_id: c.cta_gate.form_id, location_id: c.cta_gate.location_id || null } : null,
                    variant
                };
            });
            // Central retargeting pixels to inject on this site (enabled only).
            const { data: px } = await supabase.from('marketing_pixels').select('*').eq('id', 1).maybeSingle();
            const pixels = px ? {
                fb: (px.fb_enabled && px.fb_pixel_id) ? px.fb_pixel_id : null,
                google: (px.google_enabled && px.google_tag_id) ? px.google_tag_id : null,
                linkedin: (px.linkedin_enabled && px.linkedin_partner_id) ? px.linkedin_partner_id : null
            } : null;
            return res.status(200).json({ success: true, data: out, pixels });
        }

        // Only allow tracking/dismissing campaigns actually enabled for embeds,
        // so a site-key holder can't inject events for internal-only campaigns.
        const isEmbedCampaign = async (cid) => {
            if (!cid) return false;
            const { data } = await supabase.from('marketing_campaigns').select('id').eq('id', cid).eq('show_on_embed', true).maybeSingle();
            return !!data;
        };

        if (action === 'track') {
            const { campaign_id, event_type, target, variant } = body;
            if (!campaign_id || !['impression', 'click', 'dismiss'].includes(event_type)) return bad(res, 'bad params');
            if (!viewer) return ok(res, { logged: false });
            if (!(await isEmbedCampaign(campaign_id))) return bad(res, 'Unknown campaign', 404);
            if (event_type === 'impression') {
                const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
                const { data: recent } = await supabase.from('marketing_events').select('id')
                    .eq('campaign_id', campaign_id).eq('user_id', viewer).eq('event_type', 'impression')
                    .gte('created_at', since).limit(1);
                if (recent && recent.length) return ok(res, { logged: false });
            }
            await supabase.from('marketing_events').insert({
                campaign_id, user_id: viewer, user_type: 'embed', event_type, site_id: siteId, ghl_location: ghlLoc,
                target: target || null, variant: (variant === 'A' || variant === 'B') ? variant : null,
                meta: cleanMeta(body.meta), country
            });
            return ok(res, { logged: true });
        }

        if (action === 'dismiss') {
            const { campaign_id } = body;
            if (!campaign_id || !viewer) return bad(res, 'bad params');
            if (!(await isEmbedCampaign(campaign_id))) return bad(res, 'Unknown campaign', 404);
            await supabase.from('marketing_dismissals')
                .upsert({ campaign_id, user_id: viewer, user_type: 'embed' }, { onConflict: 'campaign_id,user_id' });
            await supabase.from('marketing_events').insert({ campaign_id, user_id: viewer, user_type: 'embed', event_type: 'dismiss', site_id: siteId });
            return ok(res, { dismissed: true });
        }

        if (action === 'submit_response') {
            const { campaign_id, choice, rating, name, email, phone, variant } = body;
            if (!campaign_id || !viewer) return bad(res, 'bad params');
            if (!(await isEmbedCampaign(campaign_id))) return bad(res, 'Unknown campaign', 404);
            await supabase.from('marketing_responses').insert({
                campaign_id, variant: (variant === 'A' || variant === 'B') ? variant : null,
                user_type: 'embed', user_id: viewer, site_id: siteId, ghl_location: ghlLoc,
                choice: choice ? String(choice).slice(0, 200) : null,
                rating: Number.isFinite(+rating) ? Math.round(+rating) : null,
                name: name ? String(name).slice(0, 160) : null,
                email: email ? String(email).slice(0, 200) : null,
                phone: phone ? String(phone).slice(0, 60) : null,
                country, meta: cleanMeta(body.meta)
            });
            await supabase.from('marketing_events').insert({ campaign_id, user_id: viewer, user_type: 'embed', event_type: 'click', target: 'survey', site_id: siteId, ghl_location: ghlLoc, country });
            // Push the lead to a GHL sub-account (with tags) if configured.
            if (email || phone) {
                const { data: camp } = await supabase.from('marketing_campaigns').select('survey').eq('id', campaign_id).maybeSingle();
                const cc = camp?.survey?.contact;
                if (cc && cc.push && cc.ghl_location_id) {
                    ghlUpsertContact(cc.ghl_location_id, { name, email, phone }, cc.ghl_tags || []).catch(() => {});
                }
            }
            return ok(res, { saved: true });
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error', 500);
    }
}
