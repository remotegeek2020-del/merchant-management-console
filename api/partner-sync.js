// ── PARTNER SYNC (external / Zapier ↔ HighLevel) ─────────────────────────────
// One admin-authenticated endpoint to create/update/read/deactivate partners,
// keyed by the HighLevel contact id (persons.hl_contact_id — the single unique
// reference). Designed for a HighLevel form → Zapier → this endpoint.
//
// Auth:  header  x-api-key: <PARTNER_SYNC_KEY>   (or  Authorization: Bearer <PARTNER_SYNC_KEY>)
//        Set PARTNER_SYNC_KEY in the Vercel env.
//
// Data model:
//   persons            — the partner            (hl_contact_id = unique key)
//   companies          — business name          (company_name)
//   agents             — links person ↔ company (parent_agent_id → persons.id)
//   agent_identifiers  — the Agent IDs          (id_string unique, prime49, rev_share)
//
// Verbs (all keyed by hl_contact_id):
//   GET    ?hl_contact_id=…                 → read the partner + agent IDs + business name
//   POST   { hl_contact_id, … }             → create-or-update (idempotent upsert)
//   PUT    { hl_contact_id, … }             → same as POST (idempotent upsert)
//   DELETE ?hl_contact_id=…  (or in body)   → soft-deactivate (IDs inactive + portal off)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const err = (res, message, status = 400, code = 'ERROR') => res.status(status).json({ success: false, error: { code, message } });

function toBool(v) {
    if (v === true) return true;
    if (v === false || v == null) return false;
    const s = String(v).trim().toLowerCase();
    return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'prime49' || s === 'prime 49';
}

// Accepts: "A1, A2"  |  ["A1","A2"]  |  [{id_string, prime49, rev_share}, …]
function parseAgentIds(input, defPrime49, defRev) {
    if (input == null || input === '') return [];
    let list = [];
    if (Array.isArray(input)) {
        list = input.map(x => {
            if (x && typeof x === 'object') {
                return {
                    id_string: String(x.id_string || x.id || '').trim(),
                    prime49: x.prime49 != null ? toBool(x.prime49) : defPrime49,
                    rev_share: x.rev_share != null && x.rev_share !== '' ? String(x.rev_share).replace(/%/g, '').trim() : defRev
                };
            }
            return { id_string: String(x).trim(), prime49: defPrime49, rev_share: defRev };
        });
    } else {
        list = String(input).split(/[,\n;]+/).map(s => s.trim()).filter(Boolean)
            .map(s => ({ id_string: s, prime49: defPrime49, rev_share: defRev }));
    }
    // de-dupe by id_string, drop empties
    const seen = new Set();
    return list.filter(x => x.id_string && !seen.has(x.id_string) && seen.add(x.id_string));
}

// Full read shape for a partner given their person row.
async function readPartner(person) {
    const { data: agents } = await supabase.from('agents')
        .select('id, agent_name, company_id, companies:company_id(company_name)')
        .eq('parent_agent_id', person.id);
    const agentIds = (agents || []).map(a => a.id);
    let identifiers = [];
    if (agentIds.length) {
        const { data: ids } = await supabase.from('agent_identifiers')
            .select('id_string, prime49, rev_share, status, agent_id').in('agent_id', agentIds);
        identifiers = ids || [];
    }
    const businessNames = [...new Set((agents || []).map(a => a.companies?.company_name).filter(Boolean))];
    return {
        hl_contact_id: person.hl_contact_id,
        person_id: person.id,
        full_name: person.full_name,
        email: person.email,
        phone: person.phone_number,
        is_portal_active: !!person.is_portal_active,
        business_name: businessNames[0] || null,
        business_names: businessNames,
        agent_ids: identifiers.map(i => ({ id_string: i.id_string, prime49: !!i.prime49, rev_share: i.rev_share, status: i.status }))
    };
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    // ── Auth: shared admin secret ──
    const configured = process.env.PARTNER_SYNC_KEY;
    if (!configured) return err(res, 'PARTNER_SYNC_KEY is not set on the server.', 500, 'NOT_CONFIGURED');
    const authHeader = req.headers['authorization'] || '';
    const provided = (req.headers['x-api-key'] || (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '')).trim();
    if (!provided || provided !== configured) {
        return err(res, 'Invalid or missing API key. Send it as the x-api-key header.', 401, 'UNAUTHORIZED');
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const q = req.query || {};
    const hl = String(body.hl_contact_id || q.hl_contact_id || '').trim();

    try {
        // ── GET: read a partner ──
        if (req.method === 'GET') {
            if (!hl) return err(res, 'hl_contact_id query parameter is required.', 400, 'MISSING_PARAM');
            const { data: person } = await supabase.from('persons').select('*').eq('hl_contact_id', hl).maybeSingle();
            if (!person) return err(res, 'No partner found for that hl_contact_id.', 404, 'NOT_FOUND');
            return ok(res, await readPartner(person));
        }

        // ── DELETE: soft-deactivate ──
        if (req.method === 'DELETE') {
            if (!hl) return err(res, 'hl_contact_id is required.', 400, 'MISSING_PARAM');
            const { data: person } = await supabase.from('persons').select('*').eq('hl_contact_id', hl).maybeSingle();
            if (!person) return err(res, 'No partner found for that hl_contact_id.', 404, 'NOT_FOUND');
            const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', person.id);
            const agentIds = (agents || []).map(a => a.id);
            if (agentIds.length) {
                await supabase.from('agent_identifiers').update({ status: 'inactive' }).in('agent_id', agentIds);
            }
            await supabase.from('persons').update({ is_portal_active: false }).eq('id', person.id);
            await supabase.from('partner_sessions').delete().eq('person_id', person.id);   // sign out any live sessions
            return ok(res, { hl_contact_id: hl, deactivated: true, agent_ids_deactivated: agentIds.length });
        }

        // ── POST / PUT: create-or-update (idempotent upsert by hl_contact_id) ──
        if (req.method === 'POST' || req.method === 'PUT') {
            if (!hl) return err(res, 'hl_contact_id is required.', 400, 'MISSING_PARAM');

            const fullName = (body.full_name || body.name || '').trim();
            const email = (body.email || '').trim().toLowerCase() || null;
            const phone = (body.phone || body.phone_number || '').trim() || null;
            const businessName = (body.business_name || body.company || body.company_name || '').trim();
            const defPrime49 = toBool(body.prime49);
            const defRev = (body.rev_share != null && body.rev_share !== '') ? String(body.rev_share).replace(/%/g, '').trim() : '50';
            const agentIdList = parseAgentIds(body.agent_ids != null ? body.agent_ids : body.agent_id, defPrime49, defRev);

            // 1) Upsert the person by hl_contact_id
            let person;
            const { data: existing } = await supabase.from('persons').select('*').eq('hl_contact_id', hl).maybeSingle();
            if (existing) {
                const patch = {};
                if (fullName) patch.full_name = fullName;
                if (email) patch.email = email;
                if (phone) patch.phone_number = phone;
                if (Object.keys(patch).length) {
                    const { data: updated, error: uErr } = await supabase.from('persons').update(patch).eq('id', existing.id).select().single();
                    if (uErr) return err(res, 'Person update failed: ' + uErr.message, 400, 'PERSON_UPDATE_FAILED');
                    person = updated;
                } else person = existing;
            } else {
                if (!fullName) return err(res, 'full_name is required to create a new partner.', 400, 'MISSING_PARAM');
                const rec = { full_name: fullName, hl_contact_id: hl, phone_number: phone, enrolled_at: new Date().toISOString() };
                if (email) rec.email = email;
                const { data: inserted, error: iErr } = await supabase.from('persons').insert(rec).select().single();
                if (iErr) return err(res, 'Person create failed: ' + iErr.message, 400, 'PERSON_CREATE_FAILED');
                person = inserted;
            }

            // 2) Resolve company (business name) — reuse existing by name, else create. Blank = independent.
            let companyId = null;
            if (businessName) {
                const { data: co } = await supabase.from('companies').select('id').ilike('company_name', businessName).maybeSingle();
                if (co) companyId = co.id;
                else {
                    const { data: newCo } = await supabase.from('companies').insert({ company_name: businessName }).select('id').single();
                    companyId = newCo ? newCo.id : null;
                }
            }

            // 3) Find or create the agent linking this person ↔ company
            let agentQuery = supabase.from('agents').select('id').eq('parent_agent_id', person.id);
            agentQuery = companyId ? agentQuery.eq('company_id', companyId) : agentQuery.is('company_id', null);
            let { data: agent } = await agentQuery.maybeSingle();
            if (!agent) {
                const { data: newAgent, error: aErr } = await supabase.from('agents')
                    .insert({ company_id: companyId, agent_name: person.full_name, parent_agent_id: person.id }).select('id').single();
                if (aErr) return err(res, 'Agent link failed: ' + aErr.message, 400, 'AGENT_FAILED');
                agent = newAgent;
            }

            // 4) Upsert the agent IDs (id_string unique). Existing IDs get re-pointed to this agent + updated.
            if (agentIdList.length) {
                const rows = agentIdList.map(x => ({ agent_id: agent.id, id_string: x.id_string, rev_share: x.rev_share, prime49: !!x.prime49, status: 'active' }));
                const { error: idErr } = await supabase.from('agent_identifiers').upsert(rows, { onConflict: 'id_string' });
                if (idErr) return err(res, 'Agent IDs failed: ' + idErr.message, 400, 'IDS_FAILED');
            }

            // Best-effort audit
            supabase.from('activity_logs').insert({
                email: 'partner-sync', action: `Partner sync (${existing ? 'update' : 'create'}): ${person.full_name}`,
                status: 'success', category: 'partners', target_id: person.id, target_type: 'person', severity: 'info',
                new_value: { hl_contact_id: hl, business_name: businessName || null, agent_ids: agentIdList, source: 'partner-sync' },
                ip_address: req.headers['x-forwarded-for'] || 'zapier'
            }).then(() => {}, () => {});

            const result = await readPartner(person);
            return ok(res, result, existing ? 200 : 201);
        }

        return err(res, `Method ${req.method} not allowed. Use GET, POST, PUT, or DELETE.`, 405, 'METHOD_NOT_ALLOWED');
    } catch (e) {
        return err(res, 'Server error: ' + (e.message || 'unknown'), 500, 'SERVER_ERROR');
    }
}
