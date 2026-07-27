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

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const body = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const action = body.action;

    try {
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
                .select('id, merchant_id, dba_name, merchant_address, merchant_city, merchant_state, merchant_zip, merchant_primary_contact, merchant_phone, email')
                .in('agent_id', ids).limit(10);
            if (q) query = query.or(`merchant_id.ilike.%${q}%,dba_name.ilike.%${q}%`);
            const { data } = await query;
            return ok(res, { merchants: (data || []).map(m => ({
                id: m.id, merchant_id: m.merchant_id, dba_name: m.dba_name,
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
            const { error } = await supabase.from('pos_leads').insert({
                source: 'public', agent_id: agentId, partner_id: partner?.id || null,
                partner_name: partner?.full_name || null, agent_valid: !!partner,
                ...lead, meta: (body.meta && typeof body.meta === 'object') ? body.meta : null, created_by: 'public'
            });
            if (error) return bad(res, error.message);
            return ok(res, { received: true });
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
            const { error } = await supabase.from('pos_leads').insert({
                source: 'portal', agent_id: agentId, partner_id: personId,
                partner_name: person?.full_name || null, agent_valid: true,
                ...lead, created_by: 'partner:' + personId
            });
            if (error) return bad(res, error.message);
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
            const [{ data: loc }, { data: wh }, { data: pls }, { data: sts }] = await Promise.all([
                supabase.from('app_settings').select('value').eq('key', 'pos_ghl_location_id').maybeSingle(),
                supabase.from('app_settings').select('value').eq('key', 'pos_ghl_webhook_url').maybeSingle(),
                supabase.from('pos_pipelines').select('*').order('sort_order'),
                supabase.from('pos_stages').select('*').order('sort_order')
            ]);
            const stagesByPipe = {};
            (sts || []).forEach(s => { (stagesByPipe[s.pipeline_id] = stagesByPipe[s.pipeline_id] || []).push(s); });
            const pipelines = (pls || []).map(p => ({ id: p.id, name: p.name, is_default: p.is_default, stages: stagesByPipe[p.id] || [] }));
            return ok(res, { key_set: !!pit, key_masked: pit ? ('••••' + pit.slice(-4)) : '', location_id: loc?.value || '', webhook_url: wh?.value || '', pipelines });
        }
        if (action === 'set_pos_key') {
            if (!canSettings) return bad(res, 'No access.', 403);
            // Only overwrite the key when a new one is actually provided (blank = keep existing).
            if (body.key && String(body.key).trim()) await setConfigValue('POS_GHL_PIT', String(body.key).trim(), session.userid);
            if ('location_id' in body) await supabase.from('app_settings').upsert({ key: 'pos_ghl_location_id', value: String(body.location_id || '').trim(), updated_at: new Date().toISOString(), updated_by: session.userid }, { onConflict: 'key' });
            if ('webhook_url' in body) await supabase.from('app_settings').upsert({ key: 'pos_ghl_webhook_url', value: String(body.webhook_url || '').trim(), updated_at: new Date().toISOString(), updated_by: session.userid }, { onConflict: 'key' });
            return ok(res, {});
        }
        if (action === 'save_pipeline') {
            if (!canSettings) return bad(res, 'No access.', 403);
            const name = String(body.name || '').trim(); if (!name) return bad(res, 'Pipeline name required.');
            if (body.id) { await supabase.from('pos_pipelines').update({ name }).eq('id', body.id); return ok(res, { id: body.id }); }
            const { data, error } = await supabase.from('pos_pipelines').insert({ name, sort_order: Number.isFinite(+body.sort_order) ? +body.sort_order : 0 }).select('id').single();
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
