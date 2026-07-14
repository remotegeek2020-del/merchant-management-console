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
import { validateSession as validateStaff, sessionErrorResponse } from './_validate.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ADMIN_ACTIONS = new Set([
    'list_campaigns', 'get_campaign', 'create_campaign', 'update_campaign',
    'delete_campaign', 'toggle_active', 'get_upload_url', 'get_stats', 'can_access'
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
                const rec = {
                    title: (b.title || '').trim() || 'Untitled',
                    body_text: b.body_text ?? null,
                    image_url: b.image_url ?? null,
                    content_type: ['text', 'graphic', 'both'].includes(b.content_type) ? b.content_type : 'both',
                    cta_enabled: !!b.cta_enabled,
                    cta_label: b.cta_label ?? null,
                    cta_url: b.cta_url ?? null,
                    hotspots: Array.isArray(b.hotspots) ? b.hotspots : [],
                    audience: ['partner', 'staff', 'both'].includes(b.audience) ? b.audience : 'partner',
                    display_mode: ['card_dismissible', 'card_persistent', 'floating'].includes(b.display_mode) ? b.display_mode : 'card_dismissible',
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
                    .select('event_type, user_id, user_type, target, created_at').eq('campaign_id', id);
                const rows = ev || [];
                const uniq = (t) => new Set(rows.filter(r => r.event_type === t).map(r => r.user_id)).size;
                const impressions = rows.filter(r => r.event_type === 'impression').length;
                const clicks = rows.filter(r => r.event_type === 'click').length;
                const dismissals = rows.filter(r => r.event_type === 'dismiss').length;
                const uImp = uniq('impression'), uClick = uniq('click');
                // clicks broken down by target (hotspot/cta)
                const byTarget = {};
                rows.filter(r => r.event_type === 'click').forEach(r => { const k = r.target || 'cta'; byTarget[k] = (byTarget[k] || 0) + 1; });
                const byAudience = { partner: 0, staff: 0 };
                rows.filter(r => r.event_type === 'click').forEach(r => { if (byAudience[r.user_type] != null) byAudience[r.user_type]++; });
                return ok(res, {
                    impressions, clicks, dismissals,
                    unique_impressions: uImp, unique_clicks: uClick,
                    ctr: uImp ? Math.round((uClick / uImp) * 1000) / 10 : 0,   // % of unique viewers who clicked
                    clicks_by_target: byTarget, clicks_by_audience: byAudience
                });
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
                const live = (all || []).filter(c =>
                    (!c.starts_at || new Date(c.starts_at).getTime() <= now) &&
                    (!c.ends_at || new Date(c.ends_at).getTime() >= now));
                // exclude ones this user dismissed
                const ids = live.map(c => c.id);
                let dismissed = new Set();
                if (ids.length) {
                    const { data: dis } = await supabase.from('marketing_dismissals')
                        .select('campaign_id').in('campaign_id', ids).eq('user_id', who.id);
                    dismissed = new Set((dis || []).map(d => d.campaign_id));
                }
                const out = live.filter(c => !dismissed.has(c.id)).map(c => ({
                    id: c.id, title: c.title, body_text: c.body_text, image_url: c.image_url,
                    content_type: c.content_type, cta_enabled: c.cta_enabled, cta_label: c.cta_label,
                    cta_url: c.cta_url, hotspots: c.hotspots || [], priority: c.priority,
                    display_mode: c.display_mode || 'card_dismissible'
                }));
                return ok(res, out);
            }

            if (action === 'track') {
                const { campaign_id, event_type, target } = req.body;
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
                    campaign_id, user_id: who.id, user_type: who.type, event_type, target: target || null
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
