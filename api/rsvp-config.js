// ── PARTNER RSVP EVENTS — staff config API ───────────────────────────────────
// Manage partner-exclusive RSVP events: pick a GHL sub-account, choose which of
// its custom fields to ask, a tag to apply, optional workflow. The public flow
// (api/rsvp.js + rsvp.html) validates a Partner ID, prefills contact info, asks
// the chosen questions, then upserts the HL contact + sets fields + tags.
import { createClient } from '@supabase/supabase-js';
import { validateSession as validateStaff, sessionErrorResponse } from './_validate.js';
import { ghlListCustomFields, ghlListForms, ghlListCalendars } from './_ghl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ok = (res, data = {}) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
function slug(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }

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
            const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            return ok(res, { events: (data || []).map(e => ({ ...e, submissions: counts[e.id] || 0, public_url: `${proto}://${host}/rsvp?e=${e.event_key}` })) });
        }
        if (action === 'ghl_custom_fields') {
            if (!req.body.location_id) return ok(res, { fields: [] });
            const fields = await ghlListCustomFields(req.body.location_id);
            return ok(res, { fields });
        }
        if (action === 'ghl_forms') { return ok(res, { forms: req.body.location_id ? await ghlListForms(req.body.location_id) : [] }); }
        if (action === 'ghl_calendars') { return ok(res, { calendars: req.body.location_id ? await ghlListCalendars(req.body.location_id) : [] }); }

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
