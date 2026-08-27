// ── PUBLIC EVENT INTAKE WEBHOOK ──────────────────────────────────────────────
// Receives contacts from HighLevel workflows (Inbound Webhook action) and files
// them under a show/event + the channel that brought them in. The HL workflow's
// own if/and/trigger logic decides the event + channel and sends them here, so we
// don't hardcode any of that logic — we just record what the workflow tells us.
//
// Setup in HighLevel: add a "Webhook" action in the workflow →
//   POST https://<host>/api/event-intake?secret=<EVENTS_WEBHOOK_SECRET>
//   body (JSON): { event, channel, name, email, phone, source, contact_id, tags }
// Auth = the shared ?secret= (env EVENTS_WEBHOOK_SECRET or app_config).
import { createClient } from '@supabase/supabase-js';
import { getConfigValue } from './api-config.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ok = (res, data) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

function slug(s) {
    return String(s == null ? '' : s).trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function normEmail(x) {
    const s = String(x == null ? '' : x).trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.slice(0, 200) : '';
}
// Map common channel labels to canonical keys; unknown labels are slugged as-is.
function normChannel(x) {
    const s = String(x == null ? '' : x).trim().toLowerCase();
    if (!s) return 'other';
    if (/announc|organic/.test(s)) return 'announcement';
    if (/e-?mail/.test(s)) return 'email_blast';
    if (/sms|text/.test(s)) return 'sms_blast';
    if (/\bads?\b|paid|facebook|google|meta/.test(s)) return 'ads';
    return slug(s).replace(/-/g, '_') || 'other';
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);

    // Verify the shared secret (query or header).
    const provided = String(req.query?.secret || req.headers['x-webhook-secret'] || '');
    const secret = process.env.EVENTS_WEBHOOK_SECRET || (await getConfigValue('EVENTS_WEBHOOK_SECRET'));
    if (!secret) return bad(res, 'Intake not configured (set EVENTS_WEBHOOK_SECRET).', 503);
    if (provided !== secret) return bad(res, 'Invalid secret', 403);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    try {
        // Resolve the event name/key.
        const eventName = String(body.event || body.event_name || body.show || body.campaign || '').trim();
        const eventKeyRaw = String(body.event_key || '').trim();
        const key = slug(eventKeyRaw || eventName);
        if (!key) return bad(res, 'Missing event (name or key).');

        // Find or create the event.
        let { data: ev } = await supabase.from('marketing_show_events').select('id').eq('event_key', key).maybeSingle();
        if (!ev) {
            const ins = await supabase.from('marketing_show_events')
                .insert({ name: eventName || key, event_key: key, created_by: 'webhook' })
                .select('id').single();
            ev = ins.data;
            if (!ev) return ok(res, { skipped: 'event upsert failed' });   // 200 to avoid HL retries
        }

        const channel = normChannel(body.channel || body.source);
        const email = normEmail(body.email);
        const name = String(body.name || `${body.first_name || ''} ${body.last_name || ''}`.trim() || '').slice(0, 200) || null;
        const phone = String(body.phone || body.phone_number || '').slice(0, 60) || null;
        const source = String(body.source || body.channel || '').slice(0, 120) || null;
        const contactId = String(body.contact_id || body.ghl_contact_id || body.contactId || '').slice(0, 100) || null;
        let tags = body.tags;
        if (typeof tags === 'string') tags = tags.split(',').map(t => t.trim()).filter(Boolean);
        if (!Array.isArray(tags)) tags = [];

        // Need at least an email or phone or name to file a contact.
        if (!email && !phone && !name) return ok(res, { skipped: 'no contact identity' });

        const row = { event_id: ev.id, channel, name, email: email || null, phone, source, tags, ghl_contact_id: contactId, origin: 'webhook' };
        if (email) {
            // Dedupe per (event, email, channel).
            await supabase.from('marketing_event_contacts').upsert(row, { onConflict: 'event_id,email,channel', ignoreDuplicates: false });
        } else {
            await supabase.from('marketing_event_contacts').insert(row);
        }
        await supabase.from('marketing_show_events').update({ updated_at: new Date().toISOString() }).eq('id', ev.id);
        return ok(res, { recorded: true, event_key: key, channel });
    } catch (e) {
        // Always 200 so HighLevel doesn't hammer retries; log server-side.
        console.error('[event-intake]', e.message);
        return ok(res, { skipped: 'error', error: e.message });
    }
}
