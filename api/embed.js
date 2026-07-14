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

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const action = body?.action;
    const siteKey = body?.site_key;
    const viewer = String(body?.viewer_id || '').slice(0, 200);
    if (!action) return bad(res, 'No action');
    if (!siteKey) return bad(res, 'Missing site_key', 401);

    try {
        // Validate the site key (must exist + be active).
        const { data: site } = await supabase.from('marketing_sites')
            .select('id, is_active').eq('site_key', siteKey).maybeSingle();
        if (!site || !site.is_active) return bad(res, 'Invalid or inactive site key', 403);
        const siteId = site.id;

        if (action === 'get_active') {
            if (!viewer) return ok(res, []);
            const { data: all } = await supabase.from('marketing_campaigns').select('*')
                .eq('is_active', true).eq('show_on_embed', true)
                .order('priority', { ascending: false }).order('created_at', { ascending: false });
            const now = Date.now();
            const live = (all || []).filter(c =>
                (!c.starts_at || new Date(c.starts_at).getTime() <= now) &&
                (!c.ends_at || new Date(c.ends_at).getTime() >= now) &&
                // Site scoping: [] = all embed sites, otherwise must include this site.
                (!Array.isArray(c.embed_site_ids) || c.embed_site_ids.length === 0 || c.embed_site_ids.map(String).includes(String(siteId))));

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
                return {
                    id: c.id, title: v.title, body_text: v.body_text, image_url: v.image_url,
                    content_type: c.content_type, cta_enabled: v.cta_enabled, cta_label: v.cta_label,
                    cta_url: v.cta_url, hotspots: v.hotspots || [], priority: c.priority,
                    behavior, reshow_minutes: c.reshow_minutes || 5, variant
                };
            });
            return ok(res, out);
        }

        if (action === 'track') {
            const { campaign_id, event_type, target, variant } = body;
            if (!campaign_id || !['impression', 'click', 'dismiss'].includes(event_type)) return bad(res, 'bad params');
            if (!viewer) return ok(res, { logged: false });
            if (event_type === 'impression') {
                const since = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
                const { data: recent } = await supabase.from('marketing_events').select('id')
                    .eq('campaign_id', campaign_id).eq('user_id', viewer).eq('event_type', 'impression')
                    .gte('created_at', since).limit(1);
                if (recent && recent.length) return ok(res, { logged: false });
            }
            await supabase.from('marketing_events').insert({
                campaign_id, user_id: viewer, user_type: 'embed', event_type, site_id: siteId,
                target: target || null, variant: (variant === 'A' || variant === 'B') ? variant : null
            });
            return ok(res, { logged: true });
        }

        if (action === 'dismiss') {
            const { campaign_id } = body;
            if (!campaign_id || !viewer) return bad(res, 'bad params');
            await supabase.from('marketing_dismissals')
                .upsert({ campaign_id, user_id: viewer, user_type: 'embed' }, { onConflict: 'campaign_id,user_id' });
            await supabase.from('marketing_events').insert({ campaign_id, user_id: viewer, user_type: 'embed', event_type: 'dismiss', site_id: siteId });
            return ok(res, { dismissed: true });
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error', 500);
    }
}
