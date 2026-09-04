// ── PARTNER RSVP — public flow ───────────────────────────────────────────────
// 1) config   → render config for an event (name, questions, mode).
// 2) lookup   → validate a Partner ID against the partner DB, return their
//               contact info (name/email/phone) for confirmation.
// 3) submit   → upsert the partner's HighLevel contact + set the chosen custom
//               fields + apply the RSVP tag / workflow. This IS the RSVP (HL has
//               no submit-a-form API; the tag/field fires the same automation).
import { createClient } from '@supabase/supabase-js';
import { ghlUpsertContact, ghlSetContactCustomFieldsByName, ghlAddContactTags, ghlAddContactToWorkflow, ghlFindContactByEmail } from './_ghl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
}
const ok = (res, data = {}) => res.status(200).json({ success: true, ...data });
const bad = (res, message) => res.status(200).json({ success: false, message });

async function loadEvent(key) {
    if (!key) return null;
    const { data } = await supabase.from('rsvp_events').select('*').eq('event_key', key).maybeSingle();
    return data;
}

// Resolve the partner's HighLevel contact in THIS sub-account and apply the
// RSVP tag + workflow. Upsert can fail to return an id (e.g. no email/phone
// on file for this partner) — fall back to the person's stored hl_contact_id,
// then to a live email search, before giving up. Returns
// { contactId, tagApplied, error } so the caller can record what happened
// instead of silently pretending it worked.
async function applyRsvpTagWorkflow(loc, p, name, email, phone, ev) {
    const tags = ev.rsvp_tag ? [ev.rsvp_tag] : [];
    const up = await ghlUpsertContact(loc, { name, email: email || undefined, phone: phone || undefined }, tags);
    let contactId = (up && up.id) || '';
    let error = up && !up.ok ? (up.error || null) : null;
    if (!contactId && p.hl_contact_id) contactId = p.hl_contact_id;
    if (!contactId && email) {
        const found = await ghlFindContactByEmail(loc, email);
        if (found && found.id) { contactId = found.id; error = null; }
    }
    if (!contactId) return { contactId: '', tagApplied: false, error: error || 'Could not create/find the HighLevel contact (no email/phone on file for this partner).' };
    let tagApplied = !ev.rsvp_tag;   // no tag configured = nothing to fail
    if (ev.rsvp_tag) {
        const tagRes = await ghlAddContactTags(loc, contactId, [ev.rsvp_tag]);
        tagApplied = !!tagRes.ok;
        if (!tagRes.ok) error = tagRes.error || 'Failed to apply the RSVP tag.';
    }
    if (ev.workflow_id) {
        const wfRes = await ghlAddContactToWorkflow(loc, contactId, ev.workflow_id);
        if (!wfRes.ok && !error) error = wfRes.error || 'Failed to enroll in the workflow.';
    }
    return { contactId, tagApplied, error };
}

// Already RSVP'd under any of their partner IDs for this event?
async function alreadyRegistered(eventId, personId) {
    if (!personId) return false;
    const { data } = await supabase.from('rsvp_submissions').select('id').eq('event_id', eventId).eq('person_id', personId).limit(1);
    return !!(data && data.length);
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const action = body?.action;

    try {
        if (action === 'config') {
            const ev = await loadEvent(body.event_key);
            if (!ev || !ev.enabled) return bad(res, 'This RSVP is not available.');
            const isGhlForm = ev.field_source === 'ghl_form' && ev.ghl_form_id;
            // Only expose what the public page needs (no location id / workflow ids).
            return ok(res, { event: {
                name: ev.name, intro: ev.intro, thankyou: ev.thankyou, mode: ev.mode,
                embed_url: ev.embed_url, prime49_only: !!ev.prime49_only,
                field_source: isGhlForm ? 'ghl_form' : 'custom_fields',
                ghl_form_id: isGhlForm ? ev.ghl_form_id : null,
                fields: isGhlForm ? [] : (ev.fields || []).map(f => ({ name: f.name, label: f.label, type: f.type, required: !!f.required, options: f.options || [] }))
            } });
        }

        if (action === 'lookup') {
            const ev = await loadEvent(body.event_key);
            if (!ev || !ev.enabled) return bad(res, 'This RSVP is not available.');
            const pid = String(body.partner_id || '').trim();
            if (!pid) return bad(res, 'Enter your Partner ID.');
            const { data } = await supabase.rpc('partner_contact_by_id', { p_id: pid });
            const p = Array.isArray(data) && data[0] ? data[0] : null;
            if (!p) return ok(res, { status: 'not_found' });
            if (ev.prime49_only && !p.prime49) return ok(res, { status: 'not_eligible' });
            // Already RSVP'd under ANY of their partner IDs (same person) →
            // block re-entry instead of letting them submit a second time.
            if (await alreadyRegistered(ev.id, p.person_id)) return ok(res, { status: 'already_registered', name: p.full_name || '' });
            return ok(res, {
                status: 'found',
                name: p.full_name || '',
                email: p.email || '',
                phone: p.phone || '',
                has_contact: !!p.hl_contact_id
            });
        }

        if (action === 'submit') {
            const ev = await loadEvent(body.event_key);
            if (!ev || !ev.enabled) return bad(res, 'This RSVP is not available.');
            const pid = String(body.partner_id || '').trim();
            if (!pid) return bad(res, 'Missing Partner ID.');
            const { data } = await supabase.rpc('partner_contact_by_id', { p_id: pid });
            const p = Array.isArray(data) && data[0] ? data[0] : null;
            if (!p) return bad(res, 'Partner ID not found.');
            if (ev.prime49_only && !p.prime49) return bad(res, 'This RSVP is exclusive to Prime49 partners.');
            if (await alreadyRegistered(ev.id, p.person_id)) return bad(res, "You're already registered for this event.");
            const loc = ev.ghl_location_id;
            if (!loc) return bad(res, 'This event is not fully configured (no sub-account).');

            const answers = (body.answers && typeof body.answers === 'object') ? body.answers : {};
            // Required-field check.
            for (const f of (ev.fields || [])) {
                if (f.required && !String(answers[f.name] == null ? '' : answers[f.name]).trim()) {
                    return bad(res, `Please answer: ${f.label || f.name}`);
                }
            }
            const email = String(body.email || p.email || '').trim();
            const phone = String(body.phone || p.phone || '').trim();
            const name = String(p.full_name || '').trim();

            const { contactId, tagApplied, error } = await applyRsvpTagWorkflow(loc, p, name, email, phone, ev);
            if (contactId) {
                // Set the chosen custom fields (by field name → answer).
                const cfMap = {};
                (ev.fields || []).forEach(f => { const v = answers[f.name]; if (v != null && String(v).trim() !== '') cfMap[f.name] = v; });
                if (Object.keys(cfMap).length) await ghlSetContactCustomFieldsByName(loc, contactId, cfMap);
            } else {
                console.error('[rsvp] contact resolution failed for', pid, error);
            }

            // Record the RSVP (dedupe per event + partner ID) — recorded even if
            // the HighLevel side had trouble, so the RSVP itself is never lost.
            await supabase.from('rsvp_submissions').upsert({
                event_id: ev.id, partner_id_string: pid, person_id: p.person_id || null, hl_contact_id: contactId || null,
                email, name, is_partner: true, answers, tag_applied: tagApplied, hl_error: error || null
            }, { onConflict: 'event_id,partner_id_string' });

            return ok(res, { submitted: true, thankyou: ev.thankyou || null, embed_url: ev.embed_url || null });
        }

        // HighLevel-form mode: the embedded HL form itself collects the answers
        // and writes them straight into the contact (HighLevel handles its own
        // field types — dropdowns, checkboxes, etc. — so we don't reproduce
        // them). Called once the form's submission is detected; we still own
        // applying the RSVP tag/workflow and recording the conversion.
        if (action === 'submit_ghl_form') {
            const ev = await loadEvent(body.event_key);
            if (!ev || !ev.enabled) return bad(res, 'This RSVP is not available.');
            const pid = String(body.partner_id || '').trim();
            if (!pid) return bad(res, 'Missing Partner ID.');
            const { data } = await supabase.rpc('partner_contact_by_id', { p_id: pid });
            const p = Array.isArray(data) && data[0] ? data[0] : null;
            if (!p) return bad(res, 'Partner ID not found.');
            if (ev.prime49_only && !p.prime49) return bad(res, 'This RSVP is exclusive to Prime49 partners.');
            if (await alreadyRegistered(ev.id, p.person_id)) return ok(res, { submitted: true, thankyou: ev.thankyou || null, embed_url: ev.embed_url || null });
            const loc = ev.ghl_location_id;
            if (!loc) return bad(res, 'This event is not fully configured (no sub-account).');

            const email = String(body.email || p.email || '').trim();
            const phone = String(body.phone || p.phone || '').trim();
            const name = String(p.full_name || '').trim();

            // Apply the RSVP tag/workflow (the embedded form's own submission
            // separately writes whatever fields it collected into the same
            // contact — HighLevel dedupes by email/phone).
            const { contactId, tagApplied, error } = await applyRsvpTagWorkflow(loc, p, name, email, phone, ev);
            if (!contactId) console.error('[rsvp] contact resolution failed for', pid, error);

            // Record the RSVP conversion (dedupe per event + partner ID) —
            // recorded regardless of the HighLevel side, so the conversion is
            // never lost even if tagging failed.
            await supabase.from('rsvp_submissions').upsert({
                event_id: ev.id, partner_id_string: pid, person_id: p.person_id || null, hl_contact_id: contactId || null,
                email, name, is_partner: true, answers: {}, tag_applied: tagApplied, hl_error: error || null
            }, { onConflict: 'event_id,partner_id_string' });

            return ok(res, { submitted: true, thankyou: ev.thankyou || null, embed_url: ev.embed_url || null });
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        console.error('[rsvp]', e.message);
        return bad(res, 'Something went wrong. Please try again.');
    }
}
