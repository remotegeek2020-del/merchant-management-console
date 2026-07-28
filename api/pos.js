// ── POS EXPRESS LEADS ─────────────────────────────────────────────────────────
// Portal is the front gate: leads (public form or partner portal) land here,
// get reviewed/classified, and only "good" ones are sent to HighLevel (POS
// Express) via a configured webhook. Public actions (lookup_agent / submit_public)
// need no auth; partner actions use a partner_token; staff actions a session.

import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';
import { setConfigValue, getConfigValue } from './api-config.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
const ok = (res, data) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

// Resolve an Agent ID (id_string) → its partner (person + contact).
async function resolvePartner(idString) {
    if (!idString) return null;
    const { data: ai } = await supabase.from('agent_identifiers').select('agent_id').eq('id_string', String(idString).trim()).maybeSingle();
    if (!ai?.agent_id) return null;
    const { data: agent } = await supabase.from('agents').select('parent_agent_id').eq('id', ai.agent_id).maybeSingle();
    if (!agent?.parent_agent_id) return null;
    const { data: person } = await supabase.from('persons').select('id, full_name, email, phone_number').eq('id', agent.parent_agent_id).maybeSingle();
    return person || null;
}

// All Agent ID strings that belong to the partner who owns `idString`.
async function partnerIdStringsForAgentId(idString) {
    const p = await resolvePartner(idString);
    if (!p) return [];
    return partnerAgentIds(p.id);
}

// The Agent IDs belonging to a partner (person).
async function partnerAgentIds(personId) {
    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    const ids = (agents || []).map(a => a.id);
    if (!ids.length) return [];
    const { data: idf } = await supabase.from('agent_identifiers').select('id_string').in('agent_id', ids);
    return [...new Set((idf || []).map(i => i.id_string).filter(Boolean))];
}

async function validatePartner(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

function cleanLead(b) {
    const s = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
    const first = s(b.merchant_first_name, 120), last = s(b.merchant_last_name, 120);
    return {
        submitter_name: s(b.submitter_name, 160),
        partner_phone: s(b.partner_phone, 60), partner_email: s(b.partner_email, 200),
        is_current_merchant: !!b.is_current_merchant,
        mid: s(b.mid, 60), merchant_uuid: /^[0-9a-f-]{36}$/i.test(String(b.merchant_uuid || '')) ? b.merchant_uuid : null,
        business_name: s(b.business_name, 200),          // DBA
        merchant_legal_name: s(b.merchant_legal_name, 200),
        business_type: s(b.business_type, 120),
        street_address: s(b.street_address, 250), city: s(b.city, 120), state: s(b.state, 60), zip: s(b.zip, 20),
        merchant_first_name: first, merchant_last_name: last,
        contact_name: [first, last].filter(Boolean).join(' ') || s(b.contact_name, 160),
        phone: s(b.phone, 60), email: s(b.email, 200),
        monthly_volume: Number.isFinite(+b.monthly_volume) ? +b.monthly_volume : null,
        proposal_type: s(b.proposal_type, 60),
        statement_url: s(b.statement_url, 500),
        notes: s(b.notes, 2000),
        sms_opt_in: !!b.sms_opt_in
    };
}

// ── Automation engine ──────────────────────────────────────────────────────
// Two workflow families, both edited in Settings and stored (JSON) under
// app_settings.pos_automations = { portal:[...], highlevel:[...] }.
//  - portal automations run in-portal actions (set status/classification/stage,
//    assign, add note).
//  - highlevel automations POST a field-mapped payload to a HighLevel webhook.
// Each workflow has a trigger (lead_submitted | stage_entered [+stage_id]) and a
// pipeline scope ('all' or a pipeline id). Everything is best-effort: a failing
// automation never blocks the underlying submit/move.
async function getAutomations() {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'pos_automations').maybeSingle();
    try { const c = data?.value ? JSON.parse(data.value) : {}; return { portal: c.portal || [], highlevel: c.highlevel || [] }; }
    catch (e) { return { portal: [], highlevel: [] }; }
}

// Value of a mappable lead field (direct columns + a few computed helpers).
function leadFieldValue(lead, key) {
    if (!lead) return '';
    switch (key) {
        case 'full_contact_name': return lead.contact_name || [lead.merchant_first_name, lead.merchant_last_name].filter(Boolean).join(' ');
        default: return lead[key] == null ? '' : lead[key];
    }
}

// POS Express HighLevel sub-account credentials (Private Integration token + location).
async function posGhlCreds() {
    const token = await getConfigValue('POS_GHL_PIT');
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'pos_ghl_location_id').maybeSingle();
    return { token: token || '', locationId: (data?.value || '').trim() };
}
function ghlHeaders(token) {
    return { 'Authorization': 'Bearer ' + token, 'Version': '2021-07-28', 'Content-Type': 'application/json', 'Accept': 'application/json' };
}
const GHL_STD_FIELDS = new Set(['firstName', 'lastName', 'name', 'email', 'phone', 'companyName', 'address1', 'city', 'state', 'postalCode', 'country', 'website', 'source']);

// Send a lead to HighLevel: upsert the contact from the field mapping, then
// enroll it into the chosen workflow. `act` carries mapping[] and workflow_id.
// Falls back to a webhook POST only when no Private Integration token is set.
// Returns a diagnostics object (used by the "Test send" button; the automation
// runner ignores it).
async function sendToHighlevel(act, lead) {
    const { token, locationId } = await posGhlCreds();
    if (token && locationId) {
        const contact = { locationId };
        const customFields = [];
        (act.mapping || []).forEach(m => {
            if (!m || !m.source || !m.target) return;
            const v = leadFieldValue(lead, m.source);
            if (String(m.target).startsWith('cf:')) customFields.push({ id: String(m.target).slice(3), value: v });
            else contact[m.target] = v;
        });
        if (customFields.length) contact.customFields = customFields;
        const out = { mode: 'api', fields_sent: Object.keys(contact).filter(k => k !== 'locationId').length + customFields.length };
        let contactId = null;
        try {
            const r = await fetch('https://services.leadconnectorhq.com/contacts/upsert', { method: 'POST', headers: ghlHeaders(token), body: JSON.stringify(contact) });
            const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch (e) {}
            contactId = j?.contact?.id || j?.id || null;
            out.upsert_status = r.status;
            if (!r.ok) out.upsert_error = (j.message ? (Array.isArray(j.message) ? j.message.join('; ') : j.message) : txt.slice(0, 200));
        } catch (e) { out.upsert_error = 'Request failed: ' + (e.message || 'unknown'); }
        out.contact_id = contactId;
        if (contactId && act.workflow_id) {
            try {
                const r = await fetch('https://services.leadconnectorhq.com/contacts/' + contactId + '/workflow/' + act.workflow_id, { method: 'POST', headers: ghlHeaders(token), body: JSON.stringify({}) });
                const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch (e) {}
                out.enroll_status = r.status; out.enrolled = r.ok;
                if (!r.ok) out.enroll_error = (j.message ? (Array.isArray(j.message) ? j.message.join('; ') : j.message) : txt.slice(0, 200));
            } catch (e) { out.enroll_error = 'Request failed: ' + (e.message || 'unknown'); }
        } else if (!act.workflow_id) out.enroll_error = 'No workflow selected on this action.';
        if (contactId) await supabase.from('pos_leads').update({ ghl_contact_id: contactId, ghl_sent_at: new Date().toISOString() }).eq('id', lead.id);
        out.ok = !!contactId && (!act.workflow_id || out.enrolled === true);
        return out;
    }
    // Fallback: no PIT — POST the mapped payload to the connection webhook.
    let url = (act.webhook_url && String(act.webhook_url).trim()) || '';
    if (!url) {
        const { data: cfg } = await supabase.from('app_settings').select('value').eq('key', 'pos_ghl_webhook_url').maybeSingle();
        url = cfg?.value || '';
    }
    if (!url) return { mode: 'none', ok: false, upsert_error: 'No Private Integration key and no webhook configured.' };
    const payload = { pos_lead_id: lead.id };
    (act.mapping || []).forEach(m => { if (m && m.source && m.target) payload[m.target] = leadFieldValue(lead, m.source); });
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (r.ok) await supabase.from('pos_leads').update({ ghl_sent_at: new Date().toISOString() }).eq('id', lead.id);
    return { mode: 'webhook', ok: r.ok, upsert_status: r.status };
}

async function runPortalActions(wf, lead) {
    const patch = {};
    for (const act of (wf.actions || [])) {
        if (!act || !act.type) continue;
        if (act.type === 'set_status' && act.value) patch.status = act.value;
        else if (act.type === 'set_classification' && act.value) patch.classification = act.value;
        else if (act.type === 'assign_to' && act.value) patch.assigned_to = act.value;
        else if (act.type === 'move_stage' && act.stage_id) {
            const { data: stage } = await supabase.from('pos_stages').select('id, pipeline_id').eq('id', act.stage_id).maybeSingle();
            if (stage) { patch.stage_id = stage.id; patch.pipeline_id = stage.pipeline_id; }
        } else if (act.type === 'add_note' && act.value) {
            patch.review_notes = (lead.review_notes ? lead.review_notes + '\n' : '') + act.value;
        } else if (act.type === 'send_to_highlevel') {
            // Apply any pending patch first so the send reflects prior actions.
            if (Object.keys(patch).length) { patch.updated_at = new Date().toISOString(); await supabase.from('pos_leads').update(patch).eq('id', lead.id); Object.assign(lead, patch); for (const k of Object.keys(patch)) delete patch[k]; }
            try { await sendToHighlevel(act, lead); } catch (e) { /* best-effort */ }
        }
    }
    if (Object.keys(patch).length) {
        patch.updated_at = new Date().toISOString();
        await supabase.from('pos_leads').update(patch).eq('id', lead.id);
        Object.assign(lead, patch); // keep in-memory lead current for later workflows
    }
}

async function runAutomations(triggerType, lead, opts = {}) {
    try {
        const auto = await getAutomations();
        const pid = lead.pipeline_id || null;
        const matches = (wf) => wf && wf.enabled !== false
            && wf.trigger && wf.trigger.type === triggerType
            && (!wf.pipeline_id || wf.pipeline_id === 'all' || wf.pipeline_id === pid)
            && (triggerType !== 'stage_entered' || !wf.trigger.stage_id || wf.trigger.stage_id === opts.stage_id);
        for (const wf of (auto.portal || []).filter(matches)) { try { await runPortalActions(wf, lead); } catch (e) { /* best-effort */ } }
    } catch (e) { /* never block the caller */ }
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const body = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const action = body.action;

    try {
        // ── PUBLIC: form designer config (drives poslead.html styling/fields) ──
        if (action === 'form_config') {
            const { data } = await supabase.from('app_settings').select('value').eq('key', 'pos_form_config').maybeSingle();
            let cfg = {};
            try { cfg = data?.value ? JSON.parse(data.value) : {}; } catch (e) { cfg = {}; }
            return ok(res, { config: cfg });
        }
        // ── PUBLIC: validate an agent id → confirm partner + contact ──
        if (action === 'lookup_agent') {
            const p = await resolvePartner(body.agent_id);
            return ok(res, { valid: !!p, partner_name: p?.full_name || null, partner_phone: p?.phone_number || null, partner_email: p?.email || null });
        }

        // ── PUBLIC: find the partner's own merchants by MID or DBA (scoped) ──
        if (action === 'merchant_lookup') {
            const ids = await partnerIdStringsForAgentId(body.agent_id);
            if (!ids.length) return ok(res, { merchants: [] });
            const q = String(body.q || '').trim();
            let query = supabase.from('merchants')
                .select('id, merchant_id, agent_id, dba_name, merchant_address, merchant_city, merchant_state, merchant_zip, merchant_primary_contact, merchant_phone, email')
                .in('agent_id', ids).limit(10);
            if (q) query = query.or(`merchant_id.ilike.%${q}%,dba_name.ilike.%${q}%`);
            const { data } = await query;
            return ok(res, { merchants: (data || []).map(m => ({
                id: m.id, merchant_id: m.merchant_id, agent_id: m.agent_id, dba_name: m.dba_name,
                street_address: m.merchant_address, city: m.merchant_city, state: m.merchant_state, zip: m.merchant_zip,
                contact: m.merchant_primary_contact, phone: m.merchant_phone, email: m.email
            })) });
        }

        // ── PUBLIC: signed upload URL for a processing statement ──
        if (action === 'statement_upload_url') {
            const ext = String(body.ext || 'pdf').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'pdf';
            const rand = Array.from({ length: 20 }, () => '0123456789abcdef'[Math.floor((Date.now() + Math.random() * 1e6) % 16)]).join('');
            const path = `statements/${rand}.${ext}`;
            const { data, error } = await supabase.storage.from('pos-statements').createSignedUploadUrl(path);
            if (error) return bad(res, error.message);
            const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/pos-statements/${path}`;
            return ok(res, { upload_url: data.signedUrl, token: data.token, path, public_url: publicUrl });
        }

        // ── PUBLIC: submit a lead from the external form ──
        if (action === 'submit_public') {
            const lead = cleanLead(body);
            if (!lead.business_name && !lead.contact_name && !lead.email && !lead.phone) return bad(res, 'Please fill in the lead details.');
            const agentId = body.agent_id ? String(body.agent_id).trim() : null;
            const partner = agentId ? await resolvePartner(agentId) : null;
            const { data: row, error } = await supabase.from('pos_leads').insert({
                source: 'public', agent_id: agentId, partner_id: partner?.id || null,
                partner_name: partner?.full_name || null, agent_valid: !!partner,
                ...lead, meta: (body.meta && typeof body.meta === 'object') ? body.meta : null, created_by: 'public'
            }).select('*').single();
            if (error) return bad(res, error.message);
            await runAutomations('lead_submitted', row);
            return ok(res, { received: true });
        }

        // ── PARTNER: notes on one of THEIR leads (read + add) ──
        if (action === 'lead_notes_get' || action === 'lead_note_add') {
            const personId = await validatePartner(body.partner_token);
            if (!personId) return bad(res, 'Not signed in', 401);
            const { data: lead } = await supabase.from('pos_leads').select('id, partner_id, agent_id').eq('id', body.lead_id).maybeSingle();
            if (!lead) return bad(res, 'Lead not found', 404);
            let owns = lead.partner_id === personId;
            if (!owns) { const ids = await partnerAgentIds(personId); owns = !!lead.agent_id && ids.includes(lead.agent_id); }
            if (!owns) return bad(res, 'Not your lead', 403);
            if (action === 'lead_note_add') {
                const bodyText = String(body.body || '').trim().slice(0, 2000);
                if (!bodyText) return bad(res, 'Note is empty.');
                const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).maybeSingle();
                await supabase.from('pos_lead_notes').insert({ lead_id: body.lead_id, author_type: 'partner', author_id: personId, author_name: person?.full_name || 'Partner', body: bodyText });
            }
            const { data: notes } = await supabase.from('pos_lead_notes').select('id, author_type, author_name, body, created_at').eq('lead_id', body.lead_id).order('created_at', { ascending: true });
            return ok(res, { notes: notes || [] });
        }

        // ── PARTNER (portal): the leads THIS partner submitted (read-only) ──
        if (action === 'my_pos_leads') {
            const personId = await validatePartner(body.partner_token);
            if (!personId) return bad(res, 'Not signed in', 401);
            const ids = await partnerAgentIds(personId);
            let q = supabase.from('pos_leads').select('*').order('created_at', { ascending: false }).limit(500);
            const ors = [`partner_id.eq.${personId}`];
            if (ids.length) ors.push(`agent_id.in.(${ids.map(i => `"${i}"`).join(',')})`);
            q = q.or(ors.join(','));
            const { data } = await q;
            const rows = data || [];
            // Staff-defined pipeline (default, else first) + its ordered stages,
            // so partners can see stage progress. Also a name map for any stage.
            const [{ data: pls }, { data: allStages }] = await Promise.all([
                supabase.from('pos_pipelines').select('*').order('sort_order'),
                supabase.from('pos_stages').select('id, name, pipeline_id, sort_order').order('sort_order')
            ]);
            const stageMap = {};
            (allStages || []).forEach(s => { stageMap[s.id] = s.name; });
            // Only pipelines staff marked visible to partners; prefer default, else first.
            const visible = (pls || []).filter(p => p.partner_visible !== false);
            const chosen = visible.find(p => p.is_default) || visible[0] || null;
            const pipeline = chosen ? {
                id: chosen.id, name: chosen.name,
                stages: (allStages || []).filter(s => s.pipeline_id === chosen.id).map(s => ({ id: s.id, name: s.name }))
            } : null;
            // Note counts per lead (for the card badge).
            const noteCount = {};
            const leadIds = rows.map(l => l.id);
            if (leadIds.length) {
                const { data: ns } = await supabase.from('pos_lead_notes').select('lead_id').in('lead_id', leadIds);
                (ns || []).forEach(n => { noteCount[n.lead_id] = (noteCount[n.lead_id] || 0) + 1; });
            }
            const leads = rows.map(l => ({
                id: l.id, business_name: l.business_name, contact_name: l.contact_name,
                city: l.city, state: l.state, monthly_volume: l.monthly_volume,
                status: l.status, stage_id: l.stage_id || null, stage_name: stageMap[l.stage_id] || null,
                agent_id: l.agent_id, source: l.source, created_at: l.created_at, note_count: noteCount[l.id] || 0
            }));
            return ok(res, { leads, pipeline });
        }

        // ── PARTNER (portal): list my agent ids + submit ──
        if (action === 'my_agent_ids' || action === 'submit_portal') {
            const personId = await validatePartner(body.partner_token);
            if (!personId) return bad(res, 'Not signed in', 401);
            if (action === 'my_agent_ids') {
                const ids = await partnerAgentIds(personId);
                return ok(res, { agent_ids: ids });
            }
            // submit_portal — the chosen agent id must belong to this partner
            const ids = await partnerAgentIds(personId);
            const agentId = body.agent_id ? String(body.agent_id).trim() : (ids[0] || null);
            if (agentId && !ids.includes(agentId)) return bad(res, 'That Agent ID is not on your account.');
            const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).maybeSingle();
            const lead = cleanLead(body);
            if (!lead.business_name && !lead.contact_name && !lead.email && !lead.phone) return bad(res, 'Please fill in the lead details.');
            const { data: row, error } = await supabase.from('pos_leads').insert({
                source: 'portal', agent_id: agentId, partner_id: personId,
                partner_name: person?.full_name || null, agent_valid: true,
                ...lead, created_by: 'partner:' + personId
            }).select('*').single();
            if (error) return bad(res, error.message);
            await runAutomations('lead_submitted', row);
            return ok(res, { received: true });
        }

        // ── STAFF (session) ──
        const session = await validateSession(req);
        if (!session) return bad(res, 'Unauthorized', 401);
        const { data: actor } = await supabase.from('app_users').select('role, first_name, last_name, access_pos_express, access_pos_settings').eq('userid', session.userid).maybeSingle();
        const role = String(actor?.role || '').toLowerCase();
        // Super admins always; everyone else needs the granular POS Express flag.
        const canPos = role.includes('super') || actor?.access_pos_express === true;
        if (!canPos) return bad(res, 'Access denied. Ask an admin to enable POS Express for your account.', 403);
        const canSettings = role.includes('super') || actor?.access_pos_settings === true;

        // ── SETTINGS (sub-granular access) ──
        if (action === 'settings_get') {
            if (!canSettings) return bad(res, 'No access to POS Express Settings.', 403);
            const pit = await getConfigValue('POS_GHL_PIT');
            const [{ data: loc }, { data: wh }, { data: fc }, { data: au }, { data: pls }, { data: sts }, { data: staff }] = await Promise.all([
                supabase.from('app_settings').select('value').eq('key', 'pos_ghl_location_id').maybeSingle(),
                supabase.from('app_settings').select('value').eq('key', 'pos_ghl_webhook_url').maybeSingle(),
                supabase.from('app_settings').select('value').eq('key', 'pos_form_config').maybeSingle(),
                supabase.from('app_settings').select('value').eq('key', 'pos_automations').maybeSingle(),
                supabase.from('pos_pipelines').select('*').order('sort_order'),
                supabase.from('pos_stages').select('*').order('sort_order'),
                supabase.from('app_users').select('userid, first_name, last_name').order('first_name')
            ]);
            const stagesByPipe = {};
            (sts || []).forEach(s => { (stagesByPipe[s.pipeline_id] = stagesByPipe[s.pipeline_id] || []).push(s); });
            const pipelines = (pls || []).map(p => ({ id: p.id, name: p.name, is_default: p.is_default, partner_visible: p.partner_visible !== false, stages: stagesByPipe[p.id] || [] }));
            let formConfig = {}, automations = { portal: [], highlevel: [] };
            try { formConfig = fc?.value ? JSON.parse(fc.value) : {}; } catch (e) { formConfig = {}; }
            try { const a = au?.value ? JSON.parse(au.value) : {}; automations = { portal: a.portal || [], highlevel: a.highlevel || [] }; } catch (e) { automations = { portal: [], highlevel: [] }; }
            const staffList = (staff || []).map(u => ({ userid: u.userid, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.userid }));
            return ok(res, { key_set: !!pit, key_masked: pit ? ('••••' + pit.slice(-4)) : '', key_len: pit ? pit.length : 0, location_id: loc?.value || '', webhook_url: wh?.value || '', pipelines, form_config: formConfig, automations, staff: staffList });
        }
        if (action === 'set_pos_key') {
            if (!canSettings) return bad(res, 'No access.', 403);
            // Only overwrite the key when a new one is actually provided (blank = keep existing).
            let key_saved = false;
            if (body.key && String(body.key).trim()) {
                const okSave = await setConfigValue('POS_GHL_PIT', String(body.key).trim(), session.userid);
                if (!okSave) return bad(res, 'Failed to store the token.');
                key_saved = true;
            }
            if ('location_id' in body) await supabase.from('app_settings').upsert({ key: 'pos_ghl_location_id', value: String(body.location_id || '').trim(), updated_at: new Date().toISOString(), updated_by: session.userid }, { onConflict: 'key' });
            if ('webhook_url' in body) await supabase.from('app_settings').upsert({ key: 'pos_ghl_webhook_url', value: String(body.webhook_url || '').trim(), updated_at: new Date().toISOString(), updated_by: session.userid }, { onConflict: 'key' });
            // Read back what is now stored so the UI can confirm.
            const pit = await getConfigValue('POS_GHL_PIT');
            return ok(res, { key_saved, key_set: !!pit, key_masked: pit ? ('••••' + pit.slice(-4)) : '', key_len: pit ? pit.length : 0 });
        }
        if (action === 'form_config_set') {
            if (!canSettings) return bad(res, 'No access.', 403);
            const cfg = body.config && typeof body.config === 'object' ? body.config : {};
            await supabase.from('app_settings').upsert({ key: 'pos_form_config', value: JSON.stringify(cfg), updated_at: new Date().toISOString(), updated_by: session.userid }, { onConflict: 'key' });
            return ok(res, {});
        }
        // Live HighLevel metadata for the automation builder: workflows to enroll
        // into + custom fields to map onto. Uses the POS Express PIT + location.
        if (action === 'ghl_meta') {
            if (!canSettings) return bad(res, 'No access.', 403);
            const { token, locationId } = await posGhlCreds();
            if (!token || !locationId) return ok(res, { configured: false, workflows: [], custom_fields: [], wf_error: !token ? 'No Private Integration key set.' : 'No Location ID set.' });
            let workflows = [], custom_fields = [], wf_error = null, cf_error = null;
            try {
                const r = await fetch('https://services.leadconnectorhq.com/workflows/?locationId=' + encodeURIComponent(locationId), { headers: ghlHeaders(token) });
                const txt = await r.text();
                let j = {}; try { j = JSON.parse(txt); } catch (e) { j = {}; }
                if (!r.ok) wf_error = 'HTTP ' + r.status + (j.message ? ': ' + (Array.isArray(j.message) ? j.message.join('; ') : j.message) : (txt ? ': ' + txt.slice(0, 200) : ''));
                else workflows = (j.workflows || []).map(w => ({ id: w.id, name: w.name, status: w.status }));
            } catch (e) { wf_error = 'Request failed: ' + (e.message || 'unknown'); }
            try {
                const r = await fetch('https://services.leadconnectorhq.com/locations/' + encodeURIComponent(locationId) + '/customFields?model=contact', { headers: ghlHeaders(token) });
                const txt = await r.text();
                let j = {}; try { j = JSON.parse(txt); } catch (e) { j = {}; }
                if (!r.ok) cf_error = 'HTTP ' + r.status + (j.message ? ': ' + (Array.isArray(j.message) ? j.message.join('; ') : j.message) : '');
                else custom_fields = (j.customFields || []).map(f => ({ id: f.id, name: f.name }));
            } catch (e) { cf_error = 'Request failed: ' + (e.message || 'unknown'); }
            return ok(res, { configured: true, workflows, custom_fields, wf_error, cf_error, location_id: locationId });
        }
        if (action === 'automations_set') {
            if (!canSettings) return bad(res, 'No access.', 403);
            const a = body.automations && typeof body.automations === 'object' ? body.automations : {};
            const clean = { portal: Array.isArray(a.portal) ? a.portal : [], highlevel: Array.isArray(a.highlevel) ? a.highlevel : [] };
            await supabase.from('app_settings').upsert({ key: 'pos_automations', value: JSON.stringify(clean), updated_at: new Date().toISOString(), updated_by: session.userid }, { onConflict: 'key' });
            return ok(res, {});
        }
        if (action === 'save_pipeline') {
            if (!canSettings) return bad(res, 'No access.', 403);
            const name = String(body.name || '').trim(); if (!name) return bad(res, 'Pipeline name required.');
            if (body.id) {
                const patch = { name };
                if ('partner_visible' in body) patch.partner_visible = !!body.partner_visible;
                await supabase.from('pos_pipelines').update(patch).eq('id', body.id);
                return ok(res, { id: body.id });
            }
            const insert = { name, sort_order: Number.isFinite(+body.sort_order) ? +body.sort_order : 0 };
            if ('partner_visible' in body) insert.partner_visible = !!body.partner_visible;
            const { data, error } = await supabase.from('pos_pipelines').insert(insert).select('id').single();
            if (error) return bad(res, error.message);
            return ok(res, { id: data.id });
        }
        if (action === 'delete_pipeline') {
            if (!canSettings) return bad(res, 'No access.', 403);
            await supabase.from('pos_pipelines').delete().eq('id', body.id);
            return ok(res, { deleted: true });
        }
        if (action === 'save_stages') {
            if (!canSettings) return bad(res, 'No access.', 403);
            const pid = body.pipeline_id; if (!pid) return bad(res, 'pipeline_id required.');
            const stages = Array.isArray(body.stages) ? body.stages : [];
            const keepIds = stages.filter(s => s.id).map(s => s.id);
            // Delete removed stages.
            let delQ = supabase.from('pos_stages').delete().eq('pipeline_id', pid);
            if (keepIds.length) delQ = delQ.not('id', 'in', '(' + keepIds.map(id => `"${id}"`).join(',') + ')');
            await delQ;
            // Upsert provided stages with order.
            for (let i = 0; i < stages.length; i++) {
                const s = stages[i];
                const row = { pipeline_id: pid, name: String(s.name || '').slice(0, 120), sort_order: i, workflow_url: s.workflow_url ? String(s.workflow_url).slice(0, 500) : null };
                if (s.id) await supabase.from('pos_stages').update(row).eq('id', s.id);
                else await supabase.from('pos_stages').insert(row);
            }
            return ok(res, {});
        }

        if (action === 'list') {
            let q = supabase.from('pos_leads').select('*').order('created_at', { ascending: false }).limit(1000);
            if (body.status) q = q.eq('status', body.status);
            const { data } = await q;
            return ok(res, { leads: data || [] });
        }
        if (action === 'update') {
            const patch = {};
            ['status', 'classification', 'review_notes', 'assigned_to'].forEach(k => { if (k in body) patch[k] = body[k]; });
            patch.updated_at = new Date().toISOString();
            const { error } = await supabase.from('pos_leads').update(patch).eq('id', body.id);
            if (error) return bad(res, error.message);
            return ok(res, {});
        }
        // List the Send-to-HighLevel actions configured across portal automations
        // (for the "Test send" picker on a lead).
        if (action === 'hl_actions_list') {
            const auto = await getAutomations();
            const list = [];
            (auto.portal || []).forEach(wf => {
                (wf.actions || []).forEach((a, idx) => {
                    if (a && a.type === 'send_to_highlevel') list.push({ wf_id: wf.id, wf_name: wf.name || '(unnamed)', act_index: idx, workflow_name: a.workflow_name || '', map_count: (a.mapping || []).length });
                });
            });
            return ok(res, { actions: list });
        }
        // Run one Send-to-HighLevel action against a lead and return diagnostics.
        if (action === 'test_hl_send') {
            const { data: lead } = await supabase.from('pos_leads').select('*').eq('id', body.id).maybeSingle();
            if (!lead) return bad(res, 'Lead not found', 404);
            const auto = await getAutomations();
            const wf = (auto.portal || []).find(w => w.id === body.wf_id);
            const act = wf && (wf.actions || [])[body.act_index];
            if (!act || act.type !== 'send_to_highlevel') return bad(res, 'Send-to-HighLevel action not found', 404);
            let result;
            try { result = await sendToHighlevel(act, lead); } catch (e) { return bad(res, 'Send failed: ' + e.message); }
            return ok(res, { result: result || {} });
        }
        if (action === 'send_to_ghl') {
            const { data: lead } = await supabase.from('pos_leads').select('*').eq('id', body.id).maybeSingle();
            if (!lead) return bad(res, 'Lead not found', 404);
            const { data: cfg } = await supabase.from('app_settings').select('value').eq('key', 'pos_ghl_webhook_url').maybeSingle();
            const url = cfg?.value;
            if (!url) return bad(res, 'POS Express webhook URL is not configured (Settings).');
            try {
                const payload = {
                    business_name: lead.business_name, contact_name: lead.contact_name,
                    email: lead.email, phone: lead.phone, city: lead.city, state: lead.state,
                    business_type: lead.business_type, monthly_volume: lead.monthly_volume, notes: lead.notes,
                    agent_id: lead.agent_id, partner_id: lead.partner_id, partner_name: lead.partner_name,
                    pos_lead_id: lead.id
                };
                const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (!r.ok) return bad(res, 'Webhook returned HTTP ' + r.status);
            } catch (e) { return bad(res, 'Webhook failed: ' + e.message); }
            await supabase.from('pos_leads').update({ status: 'sent', classification: 'good', ghl_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', lead.id);
            return ok(res, { sent: true });
        }
        // Read-only pipelines+stages for any POS user (drives the kanban board).
        if (action === 'pipelines_get') {
            const [{ data: pls }, { data: sts }] = await Promise.all([
                supabase.from('pos_pipelines').select('*').order('sort_order'),
                supabase.from('pos_stages').select('*').order('sort_order')
            ]);
            const byPipe = {};
            (sts || []).forEach(s => { (byPipe[s.pipeline_id] = byPipe[s.pipeline_id] || []).push(s); });
            const pipelines = (pls || []).map(p => ({ id: p.id, name: p.name, is_default: p.is_default, stages: byPipe[p.id] || [] }));
            return ok(res, { pipelines });
        }
        // Move a lead to a stage (kanban drag). Fires the stage's workflow trigger if set.
        if (action === 'move_lead') {
            const { data: stage } = await supabase.from('pos_stages').select('*').eq('id', body.stage_id).maybeSingle();
            if (!stage) return bad(res, 'Stage not found', 404);
            const { error } = await supabase.from('pos_leads')
                .update({ pipeline_id: stage.pipeline_id, stage_id: stage.id, updated_at: new Date().toISOString() })
                .eq('id', body.id);
            if (error) return bad(res, error.message);
            let workflow_fired = false;
            if (stage.workflow_url) {
                try {
                    const { data: lead } = await supabase.from('pos_leads').select('*').eq('id', body.id).maybeSingle();
                    const r = await fetch(stage.workflow_url, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            event: 'pos_stage_entered', pipeline_id: stage.pipeline_id, stage_id: stage.id, stage_name: stage.name,
                            pos_lead_id: body.id, business_name: lead?.business_name, contact_name: lead?.contact_name,
                            email: lead?.email, phone: lead?.phone, agent_id: lead?.agent_id, partner_name: lead?.partner_name,
                            monthly_volume: lead?.monthly_volume, status: lead?.status
                        })
                    });
                    workflow_fired = r.ok;
                } catch (e) { /* best-effort — the move still succeeds */ }
            }
            // Run configured stage_entered automations (portal + HighLevel).
            const { data: movedLead } = await supabase.from('pos_leads').select('*').eq('id', body.id).maybeSingle();
            if (movedLead) await runAutomations('stage_entered', movedLead, { stage_id: stage.id });
            return ok(res, { moved: true, workflow_fired });
        }
        if (action === 'get_config') {
            const { data } = await supabase.from('app_settings').select('value').eq('key', 'pos_ghl_webhook_url').maybeSingle();
            return ok(res, { webhook_url: data?.value || '' });
        }
        if (action === 'set_config') {
            if (!(role.includes('super') || role.includes('admin'))) return bad(res, 'Admins only', 403);
            const url = String(body.webhook_url || '').trim();
            await supabase.from('app_settings').upsert({ key: 'pos_ghl_webhook_url', value: url, updated_at: new Date().toISOString(), updated_by: session.userid }, { onConflict: 'key' });
            return ok(res, {});
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
