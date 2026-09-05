// ── RSVP webhook receiver ────────────────────────────────────────────────────
// The client-side postMessage detection for the embedded HighLevel form proved
// unreliable (no consistent cross-origin message from the form widget), so the
// RSVP recording is now driven server-to-server instead: a HighLevel workflow
// triggered on "Form Submitted" for the RSVP form fires a Webhook action
// straight to this endpoint. That workflow only tells us a submission
// happened — it doesn't tag the contact itself, so THIS endpoint is what
// applies the RSVP tag + enrolls the workflow (via applyRsvpTagWorkflow),
// same as the rest of the RSVP flow, before recording the submission.
//
// URL to register in HighLevel — copy it straight from the campaign editor
// (Marketing → RSVP setup), no Vercel/dev access needed:
//   https://<host>/api/rsvp-webhook?event_key=<event_key>&secret=<per-event webhook_token>
// The token is generated and stored per RSVP event (rsvp_events.webhook_token)
// specifically so any staff member can self-serve the full URL — it never
// depends on an env var only a developer can see.
//
// No custom field setup needed — the webhook body just needs the contact's
// standard email/phone (native HighLevel fields, e.g. {{contact.email}} /
// {{contact.phone}}), same shape on every event, so this is copy-paste
// reproducible. We look the partner up by that email/phone (whichever is on
// file) rather than requiring a Partner ID field on the form.
import { createClient } from '@supabase/supabase-js';
import { alreadyRegistered, applyRsvpTagWorkflow } from './rsvp.js';

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

    try {
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
        const contact = body.contact || {};

        // Identify the event: primarily the ?event_key= this URL was registered
        // with; fall back to matching the HighLevel form id if it's in the payload.
        // event_key itself isn't secret (it's part of the public RSVP page URL),
        // so the actual auth check below is against that event's own random
        // webhook_token — not a shared/global secret.
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

        const provided = req.query?.secret || req.headers['x-webhook-secret'];
        if (!ev.webhook_token || provided !== ev.webhook_token) {
            return res.status(401).json({ success: false, message: 'Invalid webhook secret.' });
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

        // The workflow firing this webhook (Form Submitted → Webhook action) is
        // just telling us a submission happened — it does NOT tag the contact
        // itself, so we own applying the RSVP tag + enrolling the workflow here,
        // same as the rest of the RSVP flow.
        const finalEmail = email || p.email || '';
        const finalPhone = phone || p.phone || '';
        const finalName = name || p.full_name || '';
        const { contactId: resolvedContactId, tagApplied, error } = await applyRsvpTagWorkflow(
            ev.ghl_location_id, p, finalName, finalEmail, finalPhone, ev
        );
        if (!resolvedContactId) console.error('[rsvp-webhook] contact resolution failed for', pid, error);

        await supabase.from('rsvp_submissions').upsert({
            event_id: ev.id, partner_id_string: pid, person_id: p.person_id || null,
            hl_contact_id: resolvedContactId || contactId || p.hl_contact_id || null,
            email: finalEmail, name: finalName,
            is_partner: true, answers: {}, tag_applied: tagApplied, hl_error: error || null
        }, { onConflict: 'event_id,partner_id_string' });

        return res.status(200).json({ success: true, recorded: true });
    } catch (err) {
        console.error('[rsvp-webhook]', err.message);
        return res.status(200).json({ success: false, message: 'handled with error' });
    }
}
