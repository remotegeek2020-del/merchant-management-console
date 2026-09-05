// ── RSVP webhook receiver ────────────────────────────────────────────────────
// The client-side postMessage detection for the embedded HighLevel form proved
// unreliable (no consistent cross-origin message from the form widget), so the
// RSVP recording is now driven server-to-server instead: a HighLevel workflow
// (triggered on "Form Submitted" for the RSVP form, or on the RSVP tag being
// applied) fires a Webhook action straight to this endpoint. That workflow
// owns the truth about whether the form was actually submitted — we just
// record it.
//
// URL to register in HighLevel: https://<host>/api/rsvp-webhook?secret=<RSVP_WEBHOOK_SECRET>&event_key=<event_key>
//
// No custom field setup needed — the webhook body just needs the contact's
// standard email/phone (native HighLevel fields, e.g. {{contact.email}} /
// {{contact.phone}}), same on every event, so this is copy-paste reproducible.
// We look the partner up by that email/phone (whichever is on file) rather
// than requiring a Partner ID field on the form.
import { createClient } from '@supabase/supabase-js';
import { ghlAddContactToWorkflow } from './_ghl.js';
import { alreadyRegistered } from './rsvp.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function pick(obj, keys) {
    if (!obj) return '';
    for (const k of keys) {
        const v = obj[k];
        if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
}

// HighLevel webhook bodies can carry custom field values as an array of
// {id|key|name, value} under a few different shapes depending on how the
// workflow's Webhook action payload was built — check the common ones.
function findCustomField(body, hints) {
    const arrs = [];
    if (Array.isArray(body.customFields)) arrs.push(body.customFields);
    if (Array.isArray(body.custom_fields)) arrs.push(body.custom_fields);
    if (body.contact && Array.isArray(body.contact.customFields)) arrs.push(body.contact.customFields);
    for (const arr of arrs) {
        for (const f of arr) {
            const key = String(f?.key || f?.name || f?.id || '').toLowerCase();
            if (hints.some(h => key.indexOf(h) !== -1)) {
                const v = f?.value != null ? String(f.value).trim() : '';
                if (v) return v;
            }
        }
    }
    return '';
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const expected = process.env.RSVP_WEBHOOK_SECRET;
    const provided = req.query?.secret || req.headers['x-webhook-secret'];
    if (expected && provided !== expected) {
        return res.status(401).json({ success: false, message: 'Invalid webhook secret.' });
    }

    try {
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
        const contact = body.contact || {};

        // Identify the event: primarily the ?event_key= this URL was registered
        // with; fall back to matching the HighLevel form id if it's in the payload.
        const eventKey = req.query?.event_key || body.event_key || '';
        let ev = null;
        if (eventKey) {
            const { data } = await supabase.from('rsvp_events').select('*').eq('event_key', eventKey).maybeSingle();
            ev = data;
        }
        if (!ev) {
            const formId = pick(body, ['formId', 'form_id']) || pick(contact, ['formId', 'form_id']);
            if (formId) {
                const { data } = await supabase.from('rsvp_events').select('*').eq('ghl_form_id', formId).maybeSingle();
                ev = data;
            }
        }
        if (!ev || !ev.enabled) {
            console.warn('[rsvp-webhook] no matching enabled event for', eventKey);
            return res.status(200).json({ success: false, message: 'No matching RSVP event.' });
        }

        const contactId = pick(body, ['contact_id', 'contactId']) || pick(contact, ['id', 'contact_id']);
        const email = pick(body, ['email']) || pick(contact, ['email']);
        const phone = pick(body, ['phone']) || pick(contact, ['phone']);
        const nameParts = [pick(contact, ['first_name', 'firstName']), pick(contact, ['last_name', 'lastName'])].filter(Boolean);
        const name = pick(body, ['full_name', 'name']) || pick(contact, ['full_name', 'name']) || nameParts.join(' ');
        // Optional override, only if some event still has a dedicated Partner ID
        // field wired up — otherwise we resolve purely from email/phone below.
        const pidOverride = pick(body, ['ppid', 'partner_id', 'partnerId', 'partner_id_string'])
            || pick(contact, ['ppid', 'partner_id', 'partnerId'])
            || findCustomField(body, ['ppid', 'partner']);

        let p = null, pid = '';
        if (pidOverride) {
            const { data: pRows } = await supabase.rpc('partner_contact_by_id', { p_id: pidOverride });
            p = Array.isArray(pRows) && pRows[0] ? pRows[0] : null;
            pid = pidOverride;
        }
        if (!p) {
            if (!email && !phone) {
                console.warn('[rsvp-webhook] no email/phone in payload for event', eventKey);
                return res.status(200).json({ success: false, message: 'No contact email/phone in the webhook payload.' });
            }
            const { data: pRows } = await supabase.rpc('partner_contact_by_email_or_phone', { p_email: email || null, p_phone: phone || null });
            p = Array.isArray(pRows) && pRows[0] ? pRows[0] : null;
            pid = p ? (p.id_string || email || phone) : '';
        }
        if (!p) {
            console.warn('[rsvp-webhook] no partner matched for event', eventKey, email, phone);
            return res.status(200).json({ success: false, message: 'No partner matched this contact.' });
        }
        if (ev.prime49_only && !p.prime49) {
            return res.status(200).json({ success: true, ignored: 'not Prime49 eligible' });
        }

        // A partner can have several Partner IDs on file. If they already RSVP'd
        // under a DIFFERENT one of their IDs, don't record a second attendee row
        // for the same person — one attendee, however many IDs they try.
        if (await alreadyRegistered(ev.id, p.person_id, pid)) {
            return res.status(200).json({ success: true, ignored: 'already registered (same person)' });
        }

        // The workflow firing this webhook is itself the completion signal
        // (form submitted, or the tag got applied) — no need to re-apply the
        // tag ourselves. Just enroll the workflow (if configured, idempotent
        // in HighLevel) and record the RSVP (idempotent here too — repeated
        // submissions with the same Partner ID just upsert the same row).
        const resolvedContactId = contactId || p.hl_contact_id || null;
        if (ev.workflow_id && resolvedContactId) {
            await ghlAddContactToWorkflow(ev.ghl_location_id, resolvedContactId, ev.workflow_id).catch(() => {});
        }

        await supabase.from('rsvp_submissions').upsert({
            event_id: ev.id, partner_id_string: pid, person_id: p.person_id || null,
            hl_contact_id: resolvedContactId,
            email: email || p.email || '', name: name || p.full_name || '',
            is_partner: true, answers: {}, tag_applied: true, hl_error: null
        }, { onConflict: 'event_id,partner_id_string' });

        return res.status(200).json({ success: true, recorded: true });
    } catch (err) {
        console.error('[rsvp-webhook]', err.message);
        return res.status(200).json({ success: false, message: 'handled with error' });
    }
}
