// ── POS EXPRESS LEADS ─────────────────────────────────────────────────────────
// Portal is the front gate: leads (public form or partner portal) land here,
// get reviewed/classified, and only "good" ones are sent to HighLevel (POS
// Express) via a configured webhook. Public actions (lookup_agent / submit_public)
// need no auth; partner actions use a partner_token; staff actions a session.

import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
const ok = (res, data) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

// Resolve an Agent ID (id_string) → its partner (person).
async function resolvePartner(idString) {
    if (!idString) return null;
    const { data: ai } = await supabase.from('agent_identifiers').select('agent_id').eq('id_string', String(idString).trim()).maybeSingle();
    if (!ai?.agent_id) return null;
    const { data: agent } = await supabase.from('agents').select('parent_agent_id').eq('id', ai.agent_id).maybeSingle();
    if (!agent?.parent_agent_id) return null;
    const { data: person } = await supabase.from('persons').select('id, full_name').eq('id', agent.parent_agent_id).maybeSingle();
    return person || null;
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
    const s = (v, n) => (v == null ? null : String(v).slice(0, n));
    return {
        business_name: s(b.business_name, 200), contact_name: s(b.contact_name, 160),
        email: s(b.email, 200), phone: s(b.phone, 60), city: s(b.city, 120), state: s(b.state, 60),
        business_type: s(b.business_type, 120),
        monthly_volume: Number.isFinite(+b.monthly_volume) ? +b.monthly_volume : null,
        notes: s(b.notes, 2000)
    };
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const body = req.method === 'GET' ? (req.query || {}) : (req.body || {});
    const action = body.action;

    try {
        // ── PUBLIC: validate an agent id → confirm partner name ──
        if (action === 'lookup_agent') {
            const p = await resolvePartner(body.agent_id);
            return ok(res, { valid: !!p, partner_name: p?.full_name || null });
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
        const { data: actor } = await supabase.from('app_users').select('role, first_name, last_name, access_pos_express').eq('userid', session.userid).maybeSingle();
        const role = String(actor?.role || '').toLowerCase();
        // Super admins always; everyone else needs the granular POS Express flag.
        const canPos = role.includes('super') || actor?.access_pos_express === true;
        if (!canPos) return bad(res, 'Access denied. Ask an admin to enable POS Express for your account.', 403);

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
