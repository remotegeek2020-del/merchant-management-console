// ── PARTNER RSVP — public flow ───────────────────────────────────────────────
// 1) config   → render config for an event (name, questions, mode).
// 2) lookup   → validate a Partner ID against the partner DB, return their
//               contact info (name/email/phone) for confirmation.
// 3) submit   → upsert the partner's HighLevel contact + set the chosen custom
//               fields + apply the RSVP tag / workflow. This IS the RSVP (HL has
//               no submit-a-form API; the tag/field fires the same automation).
import { createClient } from '@supabase/supabase-js';
import { ghlUpsertContact, ghlSetContactCustomFieldsByName, ghlAddContactTags, ghlAddContactToWorkflow } from './_ghl.js';

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

            // Upsert the HL contact + apply the RSVP tag.
            const tags = ev.rsvp_tag ? [ev.rsvp_tag] : [];
            const up = await ghlUpsertContact(loc, { name, email: email || undefined, phone: phone || undefined }, tags);
            let contactId = (up && up.id) || p.hl_contact_id || '';
            if (!contactId) return bad(res, 'Could not create/find your HighLevel contact.');
            // Belt & suspenders: ensure the tag is applied even if upsert merged.
            if (ev.rsvp_tag) await ghlAddContactTags(loc, contactId, [ev.rsvp_tag]);
            // Set the chosen custom fields (by field name → answer).
            const cfMap = {};
            (ev.fields || []).forEach(f => { const v = answers[f.name]; if (v != null && String(v).trim() !== '') cfMap[f.name] = v; });
            if (Object.keys(cfMap).length) await ghlSetContactCustomFieldsByName(loc, contactId, cfMap);
            // Optional workflow enrollment.
            if (ev.workflow_id) await ghlAddContactToWorkflow(loc, contactId, ev.workflow_id);

            // Record the RSVP (dedupe per event + partner ID).
            await supabase.from('rsvp_submissions').upsert({
                event_id: ev.id, partner_id_string: pid, hl_contact_id: contactId,
                email, name, is_partner: true, answers
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
            const loc = ev.ghl_location_id;
            if (!loc) return bad(res, 'This event is not fully configured (no sub-account).');

            const email = String(body.email || p.email || '').trim();
            const phone = String(body.phone || p.phone || '').trim();
            const name = String(p.full_name || '').trim();

            // Upsert the HL contact + apply the RSVP tag (the embedded form's own
            // submission separately writes whatever fields it collected into the
            // same contact — HighLevel dedupes by email/phone).
            const tags = ev.rsvp_tag ? [ev.rsvp_tag] : [];
            const up = await ghlUpsertContact(loc, { name, email: email || undefined, phone: phone || undefined }, tags);
            let contactId = (up && up.id) || p.hl_contact_id || '';
            if (contactId && ev.rsvp_tag) await ghlAddContactTags(loc, contactId, [ev.rsvp_tag]);
            if (contactId && ev.workflow_id) await ghlAddContactToWorkflow(loc, contactId, ev.workflow_id);

            // Record the RSVP conversion (dedupe per event + partner ID).
            await supabase.from('rsvp_submissions').upsert({
                event_id: ev.id, partner_id_string: pid, hl_contact_id: contactId || null,
                email, name, is_partner: true, answers: {}
            }, { onConflict: 'event_id,partner_id_string' });

            return ok(res, { submitted: true, thankyou: ev.thankyou || null, embed_url: ev.embed_url || null });
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        console.error('[rsvp]', e.message);
        return bad(res, 'Something went wrong. Please try again.');
    }
}
