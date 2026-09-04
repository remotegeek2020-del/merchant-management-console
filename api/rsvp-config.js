// ── PARTNER RSVP EVENTS — staff config API ───────────────────────────────────
// Manage partner-exclusive RSVP events: pick a GHL sub-account, choose which of
// its custom fields to ask, a tag to apply, optional workflow. The public flow
// (api/rsvp.js + rsvp.html) validates a Partner ID, prefills contact info, asks
// the chosen questions, then upserts the HL contact + sets fields + tags.
import { createClient } from '@supabase/supabase-js';
import { validateSession as validateStaff, sessionErrorResponse } from './_validate.js';
import { ghlListCustomFields, ghlListForms, ghlListCalendars, ghlListWorkflows, ghlListLocations } from './_ghl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ok = (res, data = {}) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
function slug(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }

// "Night Event" preset — dark/orange base design (bold hero photo + dark card +
// orange CTA), modeled after the nightgolf.ppt.partners partner-event page.
// Seeded on a freshly-created RSVP announcement; from then on it's edited like
// any other campaign's theme in the full Marketing editor.
const NIGHT_EVENT_THEME = {
    bg: '#0b1220', text: '#cbd5e1', title: '#ffffff', accent: '#f97316', btnText: '#ffffff',
    radius: 6, width: 'wide', align: 'left', btnStyle: 'solid', btnSize: 'lg', btnAlign: 'left',
    imgPos: 'top', overlay: 'dark'
};

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
    const session = await validateStaff(req);
    if (!session) return sessionErrorResponse(res);
    const { data: caller } = await supabase.from('app_users')
        .select('role, access_marketing, first_name, last_name').eq('userid', session.userid).maybeSingle();
    if (!caller || !(caller.role === 'super_admin' || caller.role === 'admin' || caller.access_marketing === true)) return bad(res, 'Access denied.', 403);

    const action = req.body?.action;
    try {
        if (action === 'list_events') {
            const { data } = await supabase.from('rsvp_events').select('*').order('created_at', { ascending: false });
            const ids = (data || []).map(e => e.id);
            let counts = {};
            if (ids.length) {
                const { data: subs } = await supabase.from('rsvp_submissions').select('event_id').in('event_id', ids).limit(100000);
                (subs || []).forEach(s => { counts[s.event_id] = (counts[s.event_id] || 0) + 1; });
            }
            // Pull in each event's linked announcement campaign (if any) so the
            // list can show its reach/status without a second round trip.
            const campIds = [...new Set((data || []).map(e => e.campaign_id).filter(Boolean))];
            let campaigns = {};
            if (campIds.length) {
                const { data: camps } = await supabase.from('marketing_campaigns')
                    .select('id, title, is_active, audience, show_on_embed, embed_site_ids, ghl_location_ids, starts_at, ends_at')
                    .in('id', campIds);
                (camps || []).forEach(c => { campaigns[c.id] = c; });
            }
            const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            return ok(res, {
                events: (data || []).map(e => ({
                    ...e, submissions: counts[e.id] || 0, public_url: `${proto}://${host}/rsvp?e=${e.event_key}`,
                    announcement: e.campaign_id ? (campaigns[e.campaign_id] || null) : null
                }))
            });
        }
        if (action === 'ghl_locations') {
            const r = await ghlListLocations();
            return ok(res, r);
        }
        if (action === 'ghl_custom_fields') {
            if (!req.body.location_id) return ok(res, { fields: [] });
            const fields = await ghlListCustomFields(req.body.location_id);
            return ok(res, { fields });
        }
        if (action === 'ghl_forms') { return ok(res, { forms: req.body.location_id ? await ghlListForms(req.body.location_id) : [] }); }
        if (action === 'ghl_calendars') { return ok(res, { calendars: req.body.location_id ? await ghlListCalendars(req.body.location_id) : [] }); }
        if (action === 'ghl_workflows') { return ok(res, { workflows: req.body.location_id ? await ghlListWorkflows(req.body.location_id) : [] }); }

        if (action === 'save_event') {
            const b = req.body;
            const fields = Array.isArray(b.fields) ? b.fields.map(f => ({
                name: String(f.name || '').slice(0, 120),
                label: String(f.label || f.name || '').slice(0, 160),
                type: ['text', 'textarea', 'number', 'date', 'dropdown', 'checkbox'].includes(f.type) ? f.type : 'text',
                required: !!f.required,
                options: Array.isArray(f.options) ? f.options.map(o => String(o).slice(0, 120)).slice(0, 30) : []
            })).filter(f => f.name) : [];
            const row = {
                name: String(b.name || '').trim() || 'Untitled event',
                ghl_location_id: String(b.ghl_location_id || '').trim() || null,
                mode: b.mode === 'calendar' ? 'calendar' : 'form',
                fields, rsvp_tag: String(b.rsvp_tag || '').trim() || null,
                workflow_id: String(b.workflow_id || '').trim() || null,
                embed_url: String(b.embed_url || '').trim() || null,
                intro: String(b.intro || '').slice(0, 1000) || null,
                thankyou: String(b.thankyou || '').slice(0, 1000) || null,
                enabled: b.enabled !== false, updated_at: new Date().toISOString()
            };
            if (b.id) {
                const { error } = await supabase.from('rsvp_events').update(row).eq('id', b.id);
                if (error) throw error;
                return ok(res, { id: b.id });
            }
            let key = slug(b.event_key || row.name);
            const { data: ex } = await supabase.from('rsvp_events').select('id').eq('event_key', key).maybeSingle();
            if (ex) key = key + '-' + Math.random().toString(36).slice(2, 6);
            row.event_key = key;
            row.created_by = `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || String(session.userid);
            const { data, error } = await supabase.from('rsvp_events').insert(row).select('*').single();
            if (error) throw error;
            return ok(res, { id: data.id, event: data });
        }
        if (action === 'ensure_announcement') {
            // Get-or-create the marketing campaign that announces this RSVP event,
            // then hand back its id so staff can edit it in the full Marketing
            // campaign editor — same UI, same external-site/HighLevel/portal
            // targeting as every other campaign. The CTA always points at this
            // event's public RSVP link.
            const { event_id } = req.body;
            if (!event_id) return bad(res, 'event_id required');
            const { data: ev } = await supabase.from('rsvp_events').select('*').eq('id', event_id).maybeSingle();
            if (!ev) return bad(res, 'RSVP event not found', 404);
            if (ev.campaign_id) return ok(res, { campaign_id: ev.campaign_id });
            const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            const rec = {
                title: ev.name || 'Untitled event',
                body_text: ev.intro || null,
                cta_enabled: true, cta_label: 'RSVP Now',
                cta_url: `${proto}://${host}/rsvp?e=${ev.event_key}`,
                audience: 'partner', is_active: false, campaign_kind: 'classic',
                theme: NIGHT_EVENT_THEME,
                created_by: `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || String(session.userid)
            };
            const { data, error } = await supabase.from('marketing_campaigns').insert(rec).select('id').single();
            if (error) return bad(res, error.message);
            await supabase.from('rsvp_events').update({ campaign_id: data.id }).eq('id', ev.id);
            return ok(res, { campaign_id: data.id });
        }

        if (action === 'delete_event') {
            if (!req.body.id) return bad(res, 'id required');
            const { error } = await supabase.from('rsvp_events').delete().eq('id', req.body.id);
            if (error) throw error;
            return ok(res);
        }
        if (action === 'list_submissions') {
            const { data } = await supabase.from('rsvp_submissions').select('*').eq('event_id', req.body.id).order('created_at', { ascending: false }).limit(5000);
            return ok(res, { submissions: data || [] });
        }
        return bad(res, 'Unknown action');
    } catch (err) {
        console.error('RSVP config error:', err.message);
        return bad(res, err.message, 500);
    }
}
