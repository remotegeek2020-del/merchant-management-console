import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { getConfigValue } from './api-config.js';

async function sendEmail(to, subject, htmlBody, textBody) {
    if (!process.env.POSTMARK_SERVER_TOKEN || !to) return;
    try {
        const { ServerClient } = await import('postmark');
        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
        await client.sendEmail({
            From: process.env.EMAIL_FROM,
            To: to,
            Subject: subject,
            HtmlBody: htmlBody,
            TextBody: textBody,
            MessageStream: 'outbound'
        });
    } catch (e) {
        console.error('[Partners Email Error]', e.message);
    }
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, person_id, id, payload } = body;

    if (!action) return res.status(400).json({ success: false, message: "No action provided" });

    let _partnerActor = null;
    const resolveActor = async () => {
        if (_partnerActor) return _partnerActor;
        const { data } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
        _partnerActor = { email: data?.email || session.userid, name: data ? (`${data.first_name || ''} ${data.last_name || ''}`.trim() || data.email) : 'Staff' };
        return _partnerActor;
    };

    try {

        // ── GET THUMBS-UP SENT (person_ids already sent — to disable buttons) ──
        if (action === 'get_thumbs_up_sent') {
            const { data } = await supabase.from('thumbs_up_sends').select('person_id');
            return res.status(200).json({ success: true, person_ids: [...new Set((data || []).map(r => r.person_id).filter(Boolean))] });
        }

        // ── LIST THUMBS-UP LOG (Secret Dungeon activity) ──
        if (action === 'list_thumbs_up_log') {
            const { data } = await supabase.from('thumbs_up_sends')
                .select('*').order('sent_at', { ascending: false }).limit(100);
            return res.status(200).json({ success: true, data: data || [] });
        }

        // ── RESTORE THUMBS-UP (clear sends so buttons re-enable — testing) ──
        if (action === 'restore_thumbs_up') {
            const { data: caller } = await supabase.from('app_users').select('role').eq('userid', session.userid).maybeSingle();
            if (caller?.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super admin only.' });
            const onlyPerson = body.person_id || null;
            let q = supabase.from('thumbs_up_sends').delete();
            q = onlyPerson ? q.eq('person_id', onlyPerson) : q.neq('id', '00000000-0000-0000-0000-000000000000');
            const { error } = await q;
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // ── SEND THUMBS UP (forward partner/merchant info to a configured webhook) ──
        if (action === 'send_thumbs_up') {
            const tu = body.payload || {};
            // Already sent for this partner? (button should be disabled, but guard anyway)
            if (tu.person_id) {
                const { data: existing } = await supabase.from('thumbs_up_sends')
                    .select('id').eq('person_id', tu.person_id).limit(1).maybeSingle();
                if (existing) return res.status(200).json({ success: false, already: true, message: 'Thumbs up already sent for this partner.' });
            }
            const { data: setting } = await supabase.from('app_settings')
                .select('value').eq('key', 'thumbs_up_webhook_url').maybeSingle();
            const webhookUrl = (setting?.value || '').trim();
            if (!webhookUrl) {
                return res.status(200).json({ success: false, message: 'No Thumbs Up webhook is configured (set it in Secret Dungeon → Feature Flags).' });
            }
            const actor = await resolveActor();
            const outbound = {
                event: 'thumbs_up',
                partner: {
                    person_id: tu.person_id || null,
                    name: tu.full_name || null,
                    email: tu.email || null,
                    agent_ids: tu.agent_ids || []
                },
                merchants: tu.merchants || [],
                is_new_agent: !!tu.is_new_agent,
                sent_by: { name: actor.name, email: actor.email },
                sent_at: new Date().toISOString()
            };
            try {
                const r = await fetch(webhookUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(outbound)
                });
                if (!r.ok) {
                    const t = await r.text().catch(() => '');
                    return res.status(200).json({ success: false, message: `Webhook returned ${r.status}${t ? ': ' + t.slice(0, 200) : ''}` });
                }
                // Record the send so the button stays disabled (and shows in the log)
                await supabase.from('thumbs_up_sends').insert({
                    person_id: tu.person_id || null,
                    partner_name: tu.full_name || null,
                    partner_email: tu.email || null,
                    agent_ids: tu.agent_ids || [],
                    merchants: tu.merchants || [],
                    sent_by_email: actor.email,
                    sent_by_name: actor.name
                });
                supabase.from('activity_logs').insert({
                    email: actor.email,
                    action: `Thumbs Up sent by ${actor.name} — ${tu.full_name || 'partner'}`,
                    status: 'success', category: 'partners', target_type: 'person', target_id: tu.person_id || null, severity: 'info',
                    new_value: outbound
                }).then(() => {}).catch(() => {});
                return res.status(200).json({ success: true });
            } catch (e) {
                return res.status(200).json({ success: false, message: 'Failed to reach webhook: ' + e.message });
            }
        }

        if (action === 'update_person_field') {
    const { id, field, value } = body;
    const ALLOWED_PERSON_FIELDS = ['full_name', 'email', 'phone_number', 'is_branded', 'enrolled_at'];
    if (!ALLOWED_PERSON_FIELDS.includes(field)) {
        return res.status(400).json({ success: false, message: `Field '${field}' cannot be updated via this endpoint.` });
    }
    const { error } = await supabase
        .from('persons')
        .update({ [field]: value })
        .eq('id', id);
    return res.status(200).json({ success: !error });
}

   // Example of what your backend logic should look like:
if (action === 'get_orphan_ids') {
    const { query, placeholder_uuid } = body;
    const { data, error } = await supabase
        .from('agent_identifiers')
        .select('id_string')
        .eq('agent_id', placeholder_uuid) // Filter for the "Placeholder Agent"
        .ilike('id_string', `%${query}%`)  // Search the string
        .limit(10);
    return res.status(200).json({ data });
}
        if (action === 'check_existing_partners') {
            const { hl_ids } = body;
            if (!hl_ids?.length) return res.status(200).json({ success: true, existing_hl_ids: [] });
            const { data } = await supabase.from('persons').select('hl_contact_id').in('hl_contact_id', hl_ids);
            return res.status(200).json({
                success: true,
                existing_hl_ids: (data || []).map(r => r.hl_contact_id).filter(Boolean)
            });
        }

        if (action === 'get_ghl_rep_code') {
            const { hl_contact_id } = body;
            if (!hl_contact_id) return res.status(400).json({ success: false, message: 'hl_contact_id required.' });
            const ghlLocationId = (await getConfigValue('GHL_LOCATION_ID')) || process.env.GHL_LOCATION_ID;
            const ghlApiKey     = (await getConfigValue('GHL_API_KEY'))     || process.env.GHL_API_KEY;
            if (!ghlLocationId || !ghlApiKey) return res.status(200).json({ success: true, rep_code: null });
            const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28' };

            // Fetch contact and location fields in parallel
            const [contactRes, fieldsRes] = await Promise.all([
                fetch(`https://services.leadconnectorhq.com/contacts/${hl_contact_id}`, { headers: ghlHeaders }),
                fetch(`https://services.leadconnectorhq.com/locations/${ghlLocationId}/customFields`, { headers: ghlHeaders }),
            ]);
            if (!contactRes.ok) return res.status(200).json({ success: true, rep_code: null });
            const contactData = await contactRes.json();
            const contact = contactData.contact || {};
            const contactFields = contact.customFields || [];

            // First try to find rep_code directly from the field key/fieldKey on the contact
            const directMatch = contactFields.find(f =>
                (f.key && (f.key === 'rep_code' || f.key === 'contact.rep_code')) ||
                (f.fieldKey && (f.fieldKey === 'rep_code' || f.fieldKey === 'contact.rep_code'))
            );
            if (directMatch) {
                const val = directMatch.value ?? directMatch.fieldValue ?? null;
                return res.status(200).json({ success: true, rep_code: val || null });
            }

            // Fall back: match via location field definitions
            if (fieldsRes.ok) {
                const fieldsData = await fieldsRes.json();
                const locationFields = fieldsData.customFields || [];
                const repField = locationFields.find(f =>
                    f.key === 'rep_code' || f.key === 'contact.rep_code' ||
                    (f.name || '').toLowerCase().replace(/\s+/g, '_') === 'rep_code'
                );
                if (repField) {
                    const match = contactFields.find(f => f.id === repField.id);
                    if (match) {
                        const val = match.value ?? match.fieldValue ?? null;
                        return res.status(200).json({ success: true, rep_code: val || null });
                    }
                }
            }
            return res.status(200).json({ success: true, rep_code: null });
        }

        if (action === 'search_ghl') {
    const { query } = body;
    const ghlLocationId = (await getConfigValue('GHL_LOCATION_ID')) || process.env.GHL_LOCATION_ID;
    const ghlApiKey    = (await getConfigValue('GHL_API_KEY'))     || process.env.GHL_API_KEY;
    if (!ghlLocationId || !ghlApiKey) {
        return res.status(500).json({ success: false, message: 'GHL integration not configured. Set API keys in Secret Dungeon → API Key Manager.' });
    }
    const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28' };

    // If query looks like a GHL contact ID (alphanumeric, no spaces, 15-30 chars), try direct lookup first
    const looksLikeId = /^[a-zA-Z0-9]{15,30}$/.test(query.trim());
    if (looksLikeId) {
        const directRes = await fetch(`https://services.leadconnectorhq.com/contacts/${query.trim()}`, { headers: ghlHeaders });
        if (directRes.ok) {
            const directData = await directRes.json();
            const c = directData.contact;
            if (c) return res.status(200).json({ success: true, contacts: [c] });
        }
    }

    // Fall back to name/email search
    const ghlRes = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=${ghlLocationId}&query=${encodeURIComponent(query)}`, { headers: ghlHeaders });
    const data = await ghlRes.json();
    return res.status(200).json({ success: true, contacts: data.contacts || [] });
}
if (action === 'complete_onboarding') {
    const { person, company, identifiers, isQuickAdd, isQuickAddNewAgent, existingAgentId, personName, personId: quickPersonId, allowNoEmail } = body;
    let finalAgentId = existingAgentId;

    // Quick add to a NEW company for an existing person
    if (isQuickAddNewAgent) {
        // Prefer lookup by UUID (reliable); fall back to name match for older clients
        let personQuery = quickPersonId
            ? supabase.from('persons').select('id').eq('id', quickPersonId)
            : supabase.from('persons').select('id').ilike('full_name', (personName || '').trim());
        const { data: existingPerson } = await personQuery.maybeSingle();

        if (!existingPerson) return res.status(400).json({ success: false, message: 'Could not find partner: ' + personName });

        let targetCoId = company.id || null;
        if (!targetCoId && !company.isIndependent && company.name) {
            const { data: coData } = await supabase.from('companies').insert({ company_name: company.name }).select().single();
            targetCoId = coData ? coData.id : null;
        }

        const { data: agentData, error: agentErr } = await supabase.from('agents').insert({
            company_id: targetCoId,
            agent_name: (personName || '').trim(),
            parent_agent_id: existingPerson.id
        }).select().single();

        if (agentErr) return res.status(400).json({ success: false, message: 'Agent creation failed: ' + agentErr.message });
        finalAgentId = agentData.id;

    } else if (!isQuickAdd) {
        // --- START NEW PARTNER LOGIC ---
        if (!person || !person.name) return res.status(400).json({ success: false, message: "Missing person data for new partner" });

        const properName = person.name.toLowerCase().split(' ').map(s => s.charAt(0).toUpperCase() + s.substring(1)).join(' ');

        // 1. Upsert Person — hl_contact_id is the single dedup key
        let pData, pErr;

        if (person.hl_id) {
            const { data: existing } = await supabase
                .from('persons').select('id').eq('hl_contact_id', person.hl_id).maybeSingle();
            if (existing) {
                // Already exists — update in place
                const updateRecord = { full_name: properName, phone_number: person.phone, enrolled_at: person.enrolled_at || new Date().toISOString(), is_branded: !!person.is_branded };
                if (person.email) updateRecord.email = person.email;
                const { data: updated, error: updErr } = await supabase
                    .from('persons').update(updateRecord).eq('id', existing.id).select().single();
                pData = updated; pErr = updErr;
            } else {
                // New contact — insert
                if (!person.email && !allowNoEmail) return res.status(400).json({ success: false, message: "Missing email for new partner" });
                const personRecord = { full_name: properName, phone_number: person.phone, hl_contact_id: person.hl_id, enrolled_at: person.enrolled_at || new Date().toISOString(), is_branded: !!person.is_branded };
                if (person.email) personRecord.email = person.email;
                const { data: inserted, error: insErr } = await supabase.from('persons').insert(personRecord).select().single();
                pData = inserted; pErr = insErr;
            }
        } else {
            // No hl_id — fall back to email upsert (manual Add Partner wizard only)
            if (!person.email) return res.status(400).json({ success: false, message: "Missing email for new partner" });
            const personRecord = { full_name: properName, email: person.email, phone_number: person.phone, enrolled_at: person.enrolled_at || new Date().toISOString(), is_branded: !!person.is_branded };
            const { data: upserted, error: upsertErr } = await supabase.from('persons').upsert(personRecord, { onConflict: 'email' }).select().single();
            pData = upserted; pErr = upsertErr;
        }

        if (pErr || !pData) return res.status(400).json({ success: false, message: "Person failed: " + (pErr?.message || 'unknown error') });

        // 2. Handle Company — find existing by name before creating
        let targetCoId = company.id;
        if (!targetCoId && !company.isIndependent && company.name) {
            const { data: existingCo } = await supabase
                .from('companies')
                .select('id')
                .ilike('company_name', company.name.trim())
                .maybeSingle();
            if (existingCo) {
                targetCoId = existingCo.id;
            } else {
                const { data: coData } = await supabase
                    .from('companies').insert({ company_name: company.name.trim() }).select().single();
                targetCoId = coData ? coData.id : null;
            }
        }

        // 3. Find or create Agent — avoid duplicate person+company combos
        let agentQuery = supabase.from('agents').select('id').eq('parent_agent_id', pData.id);
        agentQuery = targetCoId ? agentQuery.eq('company_id', targetCoId) : agentQuery.is('company_id', null);
        const { data: existingAgent } = await agentQuery.maybeSingle();

        if (existingAgent) {
            finalAgentId = existingAgent.id;
        } else {
            const { data: agentData, error: agentErr } = await supabase.from('agents').insert({
                company_id: targetCoId,
                agent_name: properName,
                parent_agent_id: pData.id
            }).select().single();
            if (agentErr) return res.status(400).json({ success: false, message: "Agent creation failed: " + agentErr.message });
            finalAgentId = agentData.id;
        }
        // --- END NEW PARTNER LOGIC ---
    }

    // Link IDs (This runs for both modes)
    const idInserts = identifiers.map(id => ({
        agent_id: finalAgentId,
        id_string: id.string,
        rev_share: id.rev,
        prime49: id.prime,
        status: 'active'
    }));

    const { error: finalErr } = await supabase.from('agent_identifiers').upsert(idInserts, { onConflict: 'id_string' });

    // Audit log — record partner creation with all ID details
    const actor = await resolveActor();
    const prime49Ids = idInserts.filter(i => i.prime49).map(i => i.id_string);
    await supabase.from('activity_logs').insert([{
        email: actor.email,
        action: `Partner Onboarded: ${person?.name || personName || 'Unknown'}`,
        status: finalErr ? 'failure' : 'success',
        category: 'partners',
        target_id: finalAgentId,
        target_type: 'agent',
        severity: 'info',
        new_value: {
            partner_name: person?.name || personName,
            company: company?.name || (company?.isIndependent ? 'Independent' : null),
            identifiers: idInserts.map(i => ({ id_string: i.id_string, rev_share: i.rev_share, prime49: i.prime49 })),
            prime49_count: prime49Ids.length,
            prime49_ids: prime49Ids,
            is_quick_add: !!isQuickAdd,
            error: finalErr?.message || null
        },
        user_agent: req.headers['user-agent'],
        ip_address: req.headers['x-forwarded-for'] || 'Internal'
    }]);

    return res.status(200).json({ success: !finalErr, message: finalErr?.message });
}
        // --- ACTION: GET ALL AGENTS FOR DIRECT TRANSFER (includes limbo agents) ---
        if (action === 'get_all_agents_for_transfer') {
            const PLACEHOLDER = 'f1ed4ff6-a7ee-4658-9684-a1ae7cc275be';
            const { data: agents, error: ae } = await supabase
                .from('agents').select('id, parent_agent_id, company_id').neq('id', PLACEHOLDER);
            if (ae) throw ae;
            const personIds = [...new Set((agents||[]).map(a => a.parent_agent_id).filter(Boolean))];
            const companyIds = [...new Set((agents||[]).map(a => a.company_id).filter(Boolean))];
            const agentIds = (agents||[]).map(a => a.id);
            const [{ data: persons }, { data: companies }, { data: identCounts }] = await Promise.all([
                personIds.length ? supabase.from('persons').select('id, full_name, email').in('id', personIds) : { data: [] },
                companyIds.length ? supabase.from('companies').select('id, company_name').in('id', companyIds) : { data: [] },
                agentIds.length ? supabase.from('agent_identifiers').select('agent_id').in('agent_id', agentIds) : { data: [] }
            ]);
            const personMap = {};
            (persons||[]).forEach(p => { personMap[p.id] = p; });
            const companyMap = {};
            (companies||[]).forEach(c => { companyMap[c.id] = c; });
            const idCountMap = {};
            (identCounts||[]).forEach(i => { idCountMap[i.agent_id] = (idCountMap[i.agent_id]||0)+1; });
            const result = (agents||[]).map(a => {
                const person = a.parent_agent_id ? personMap[a.parent_agent_id] : null;
                const company = a.company_id ? companyMap[a.company_id] : null;
                const count = idCountMap[a.id] || 0;
                const isLimbo = (!a.company_id && count > 0) || (a.company_id && count === 0);
                return {
                    agent_id: a.id,
                    person_name: person ? person.full_name : null,
                    person_email: person ? person.email : null,
                    company_name: company ? company.company_name : null,
                    identifier_count: count,
                    is_limbo: isLimbo,
                    no_company: !a.company_id,
                    no_ids: count === 0
                };
            });
            return res.status(200).json({ success: true, data: result });
        }

        // --- ACTION: TRANSFER IDENTIFIER DIRECTLY TO A SPECIFIC AGENT ---
        if (action === 'transfer_identifier_to_agent') {
            const { identifier_id, target_agent_id } = body;
            if (!identifier_id || !target_agent_id) return res.status(400).json({ success: false, message: 'Missing identifier_id or target_agent_id' });
            const PLACEHOLDER = 'f1ed4ff6-a7ee-4658-9684-a1ae7cc275be';
            const { data: identRow, error: ie } = await supabase
                .from('agent_identifiers').select('agent_id').eq('id', identifier_id).single();
            if (ie) throw ie;
            const sourceAgentId = identRow.agent_id;
            const { error } = await supabase.from('agent_identifiers')
                .update({ agent_id: target_agent_id }).eq('id', identifier_id);
            if (error) throw error;
            // Clean up source agent if empty and not placeholder
            if (sourceAgentId !== PLACEHOLDER && sourceAgentId !== target_agent_id) {
                const { data: remaining } = await supabase.from('agent_identifiers').select('id').eq('agent_id', sourceAgentId).limit(1);
                if (remaining && remaining.length === 0) {
                    await supabase.from('agents').delete().eq('id', sourceAgentId);
                }
            }
            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET AGENTS FOR A COMPANY ---
        if (action === 'get_company_agents') {
            const { company_id } = body;
            if (!company_id) return res.status(400).json({ success: false, message: 'Missing company_id' });
            const { data: agents, error: ae } = await supabase
                .from('agents').select('id, parent_agent_id').eq('company_id', company_id);
            if (ae) throw ae;
            if (!agents || agents.length === 0) return res.status(200).json({ success: true, data: [] });
            const agentIds = agents.map(a => a.id);
            const personIds = [...new Set(agents.map(a => a.parent_agent_id).filter(Boolean))];
            const [{ data: persons }, { data: identifiers }] = await Promise.all([
                personIds.length ? supabase.from('persons').select('id, full_name, email').in('id', personIds) : { data: [] },
                supabase.from('agent_identifiers').select('id, agent_id, id_string, rev_share').in('agent_id', agentIds)
            ]);
            const personMap = Object.fromEntries((persons||[]).map(p => [p.id, p]));
            const result = agents.map(a => ({
                agent_id: a.id,
                person_id: a.parent_agent_id || null,
                person_name: personMap[a.parent_agent_id]?.full_name || '(No partner)',
                person_email: personMap[a.parent_agent_id]?.email || '',
                identifiers: (identifiers||[]).filter(i => i.agent_id === a.id).map(i => ({ id: i.id, id_string: i.id_string, rev_share: i.rev_share }))
            }));
            return res.status(200).json({ success: true, data: result });
        }

        // --- ACTION: GET INDEPENDENT IDENTIFIERS ---
        if (action === 'get_independent_identifiers') {
            const PLACEHOLDER = 'f1ed4ff6-a7ee-4658-9684-a1ae7cc275be';
            // Legacy placeholder identifiers (no person association)
            const { data: placeholderIdents, error: ie } = await supabase
                .from('agent_identifiers').select('id, id_string, rev_share, prime49').eq('agent_id', PLACEHOLDER);
            if (ie) throw ie;
            // Null-company agents (made independent — retain person association)
            const { data: nullAgents } = await supabase
                .from('agents').select('id, parent_agent_id').is('company_id', null).neq('id', PLACEHOLDER);
            let personAgentItems = [];
            if (nullAgents && nullAgents.length > 0) {
                const nullAgentIds = nullAgents.map(a => a.id);
                const personIds = [...new Set(nullAgents.map(a => a.parent_agent_id).filter(Boolean))];
                const [{ data: idents }, { data: persons }] = await Promise.all([
                    supabase.from('agent_identifiers').select('id, id_string, rev_share, prime49, agent_id').in('agent_id', nullAgentIds),
                    personIds.length ? supabase.from('persons').select('id, full_name, email').in('id', personIds) : Promise.resolve({ data: [] })
                ]);
                const personMap = {};
                (persons || []).forEach(p => { personMap[p.id] = p; });
                const agentPersonMap = {};
                nullAgents.forEach(a => { agentPersonMap[a.id] = a.parent_agent_id ? personMap[a.parent_agent_id] : null; });
                personAgentItems = (idents || []).map(i => {
                    const person = agentPersonMap[i.agent_id];
                    return { ...i, person_name: person ? person.full_name : null, person_email: person ? person.email : null, person_id: person ? person.id : null };
                });
            }
            const placeholderItems = (placeholderIdents || []).map(i => ({ ...i, person_name: null, person_email: null, person_id: null }));
            return res.status(200).json({ success: true, data: [...personAgentItems, ...placeholderItems] });
        }

        // --- ACTION: MAKE AGENT INDEPENDENT (set company_id = NULL, preserving person link) ---
        if (action === 'remove_agent_to_independent') {
            const { agent_id } = body;
            if (!agent_id) return res.status(400).json({ success: false, message: 'Missing agent_id' });
            // Clear parent_config on identifiers and remove company association from agent
            await supabase.from('agent_identifiers').update({ parent_config_id: null }).eq('agent_id', agent_id);
            const { error } = await supabase.from('agents').update({ company_id: null }).eq('id', agent_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ACTION: TRANSFER AGENT TO ANOTHER COMPANY ---
        if (action === 'transfer_agent_to_company') {
            const { agent_id, target_company_id } = body;
            if (!agent_id || !target_company_id) return res.status(400).json({ success: false, message: 'Missing agent_id or target_company_id' });
            const { error } = await supabase.from('agents').update({ company_id: target_company_id }).eq('id', agent_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ACTION: ASSIGN INDEPENDENT IDENTIFIER TO COMPANY ---
        if (action === 'assign_independent_to_company') {
            const { identifier_id, target_company_id, target_person_id } = body;
            if (!identifier_id || !target_company_id) return res.status(400).json({ success: false, message: 'Missing identifier_id or target_company_id' });
            const PLACEHOLDER = 'f1ed4ff6-a7ee-4658-9684-a1ae7cc275be';
            // Look up the identifier's current agent
            const { data: identRow, error: ie2 } = await supabase
                .from('agent_identifiers').select('agent_id').eq('id', identifier_id).single();
            if (ie2) throw ie2;
            const currentAgentId = identRow.agent_id;
            let destAgentId;
            // Determine the person to use: from null-company agent's parent_agent_id, or from target_person_id param
            let effectivePersonId = target_person_id || null;
            if (currentAgentId !== PLACEHOLDER) {
                const { data: curAgent } = await supabase.from('agents').select('parent_agent_id').eq('id', currentAgentId).single();
                if (curAgent && curAgent.parent_agent_id) effectivePersonId = curAgent.parent_agent_id;
            }
            if (effectivePersonId) {
                const { data: existing } = await supabase.from('agents').select('id')
                    .eq('parent_agent_id', effectivePersonId).eq('company_id', target_company_id).maybeSingle();
                if (existing) {
                    destAgentId = existing.id;
                } else {
                    const { data: personRow } = await supabase.from('persons').select('full_name').eq('id', effectivePersonId).single();
                    const { data: newAgent, error: ne } = await supabase.from('agents')
                        .insert({ parent_agent_id: effectivePersonId, company_id: target_company_id, agent_name: personRow?.full_name || '' }).select('id').single();
                    if (ne) throw ne;
                    destAgentId = newAgent.id;
                }
            } else {
                // No person — create an orphan agent under the company
                const { data: newAgent, error: ne } = await supabase.from('agents')
                    .insert({ company_id: target_company_id, parent_agent_id: null, agent_name: '' }).select('id').single();
                if (ne) throw ne;
                destAgentId = newAgent.id;
            }
            const { error } = await supabase.from('agent_identifiers')
                .update({ agent_id: destAgentId }).eq('id', identifier_id);
            if (error) throw error;
            // Clean up null-company agent if it has no more identifiers
            if (currentAgentId !== PLACEHOLDER && currentAgentId !== destAgentId) {
                const { data: remaining } = await supabase.from('agent_identifiers').select('id').eq('agent_id', currentAgentId).limit(1);
                if (remaining && remaining.length === 0) {
                    await supabase.from('agents').delete().eq('id', currentAgentId);
                }
            }
            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET COMPANIES WITH USAGE ---
        if (action === 'get_companies_full') {
            const { data: companies } = await supabase.from('companies').select('id, company_name').order('company_name');
            const { data: agents } = await supabase.from('agents').select('company_id');
            const usageMap = {};
            (agents||[]).forEach(a => { if(a.company_id) usageMap[a.company_id] = (usageMap[a.company_id]||0)+1; });
            const result = (companies||[]).map(c => ({ ...c, agent_count: usageMap[c.id]||0 }));
            return res.status(200).json({ success: true, data: result });
        }

        // --- ACTION: DELETE COMPANY ---
        if (action === 'delete_company') {
            const { company_id } = body;
            // Check if any agents use this company
            const { count } = await supabase.from('agents').select('*', { count:'exact', head:true }).eq('company_id', company_id);
            if (count > 0) return res.status(400).json({ success: false, message: `Cannot delete — ${count} agent(s) are linked to this company.` });
            await supabase.from('companies').delete().eq('id', company_id);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: MERGE COMPANIES ---
        if (action === 'merge_companies') {
            const { keep_id, delete_id } = body;
            // Move all agents from delete_id to keep_id
            await supabase.from('agents').update({ company_id: keep_id }).eq('company_id', delete_id);
            // Delete the duplicate
            await supabase.from('companies').delete().eq('id', delete_id);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: RENAME COMPANY ---
        if (action === 'rename_company') {
            const { company_id, name, create } = body;
            if (create || !company_id) {
                // Create new company
                const { data: newCo, error: insErr } = await supabase
                    .from('companies').insert({ company_name: name.trim() }).select('id').single();
                if (insErr) throw insErr;
                return res.status(200).json({ success: true, id: newCo.id });
            }
            await supabase.from('companies').update({ company_name: name }).eq('id', company_id);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET COMPANIES ---
        if (action === 'get_companies') {
            const { data } = await supabase.from('companies').select('id, company_name').order('company_name');
            return res.status(200).json({ success: true, data: data || [] });
        }

        // --- ACTION: GET COMPANY MERCHANTS ---
        if (action === 'get_company_merchants') {
            const { company_id } = body;
            if (!company_id) return res.status(400).json({ success: false, message: 'company_id required' });

            // Get all agents for this company
            const { data: agents, error: agentsErr } = await supabase
                .from('agents')
                .select('id')
                .eq('company_id', company_id);
            if (agentsErr) throw agentsErr;

            if (!agents || agents.length === 0) {
                return res.status(200).json({ success: true, data: [] });
            }

            const agentIds = agents.map(a => a.id);

            // Get all agent_identifier id_strings for those agents
            const { data: identifiers, error: identErr } = await supabase
                .from('agent_identifiers')
                .select('id_string')
                .in('agent_id', agentIds);
            if (identErr) throw identErr;

            if (!identifiers || identifiers.length === 0) {
                return res.status(200).json({ success: true, data: [] });
            }

            const idStrings = identifiers.map(i => i.id_string);

            // Get merchants using those identifier strings
            let allMerchants = [];
            const CHUNK = 500;
            for (let i = 0; i < idStrings.length; i += CHUNK) {
                const chunk = idStrings.slice(i, i + CHUNK);
                const { data: mChunk, error: mErr } = await supabase
                    .from('merchants')
                    .select('id, merchant_id, dba_name, account_status, volume_30_day, agent_id')
                    .in('agent_id', chunk)
                    .order('dba_name');
                if (mErr) throw mErr;
                if (mChunk) allMerchants = allMerchants.concat(mChunk);
            }

            return res.status(200).json({ success: true, data: allMerchants });
        }

        // --- ACTION: SEARCH MERCHANTS (for link modal) ---
        if (action === 'search_merchants_for_link') {
            const { query: q } = body;
            if (!q || q.trim().length < 2) return res.status(400).json({ success: false, message: 'Query too short' });
            const like = `%${q.trim()}%`;
            const [byDba, byMid] = await Promise.all([
                supabase.from('merchants').select('id, merchant_id, dba_name, account_status, agent_id').ilike('dba_name', like).limit(10),
                supabase.from('merchants').select('id, merchant_id, dba_name, account_status, agent_id').ilike('merchant_id', like).limit(10)
            ]);
            const seen = new Set();
            const results = [];
            for (const m of [...(byDba.data || []), ...(byMid.data || [])]) {
                if (!seen.has(m.merchant_id)) { seen.add(m.merchant_id); results.push(m); }
            }
            return res.status(200).json({ success: true, data: results.slice(0, 15) });
        }

        // --- ACTION: LINK MERCHANT TO COMPANY ---
        if (action === 'link_merchant') {
            const { merchant_id, company_id } = body; // merchant_id is the MID string
            if (!merchant_id || !company_id) return res.status(400).json({ success: false, message: 'merchant_id and company_id required' });

            // Find the merchant record to get its agent_id (identifier string)
            const { data: merchant, error: mErr } = await supabase
                .from('merchants')
                .select('agent_id')
                .eq('merchant_id', merchant_id)
                .single();
            if (mErr || !merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

            // Resolve identifier string → agent record
            const { data: ident, error: identErr } = await supabase
                .from('agent_identifiers')
                .select('agent_id')
                .eq('id_string', merchant.agent_id)
                .single();
            if (identErr || !ident) return res.status(404).json({ success: false, message: 'Agent identifier not found for this merchant' });

            // Update the agent's company_id
            const { error: updateErr } = await supabase
                .from('agents')
                .update({ company_id })
                .eq('id', ident.agent_id);
            if (updateErr) throw updateErr;

            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET PARTNER NOTES ---
        if (action === 'get_notes') {
            const { person_id, hl_contact_id } = body;

            // Pull fresh GHL notes and mirror them locally
            if (hl_contact_id) {
                try {
                    const ghlApiKey = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
                    if (!ghlApiKey) {
                        console.warn('[GHL Notes Sync] No GHL_API_KEY configured');
                    } else {
                        const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28', 'Accept': 'application/json' };
                        const ghlUrl = `https://services.leadconnectorhq.com/contacts/${hl_contact_id}/notes`;
                        console.log('[GHL Notes Sync] Fetching:', ghlUrl);
                        const ghlRes = await fetch(ghlUrl, { headers: ghlHeaders });
                        const ghlRawText = await ghlRes.text();
                        console.log('[GHL Notes Sync] Status:', ghlRes.status, 'Body:', ghlRawText.slice(0, 500));

                        if (ghlRes.ok) {
                            let ghlData;
                            try { ghlData = JSON.parse(ghlRawText); } catch (e) { ghlData = {}; }

                            // GHL returns { notes: [...] } — also handle 'data' as fallback
                            const ghlNotes = ghlData.notes || ghlData.data || [];
                            console.log('[GHL Notes Sync] Found', ghlNotes.length, 'notes in GHL');

                            // Build a userId→display name map by resolving each unique GHL userId
                            // against the GHL Users API, then cross-referencing with app users by email
                            const uniqueUserIds = [...new Set(ghlNotes.map(gn => gn.userId).filter(Boolean))];
                            const ghlUserNameMap = {};
                            if (uniqueUserIds.length) {
                                const { data: appUsers } = await supabase.from('app_users').select('email, first_name, last_name');
                                const appUsersByEmail = {};
                                (appUsers || []).forEach(u => {
                                    if (u.email) appUsersByEmail[u.email.toLowerCase()] = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email;
                                });
                                for (const uid of uniqueUserIds) {
                                    try {
                                        const uRes = await fetch(`https://services.leadconnectorhq.com/users/${uid}`, { headers: ghlHeaders });
                                        if (uRes.ok) {
                                            const uData = await uRes.json();
                                            const ghlUser = uData.user || uData;
                                            const email = (ghlUser.email || '').toLowerCase();
                                            // Prefer app user name matched by email, then GHL name, then default
                                            ghlUserNameMap[uid] = appUsersByEmail[email] || ghlUser.name || ghlUser.firstName || 'GoHighLevel';
                                        } else {
                                            ghlUserNameMap[uid] = 'GoHighLevel';
                                        }
                                    } catch (e) {
                                        ghlUserNameMap[uid] = 'GoHighLevel';
                                    }
                                }
                            }

                            // Load existing local GHL-sourced notes for diffing
                            const { data: existingGhlNotes, error: fetchErr } = await supabase
                                .from('partner_notes')
                                .select('id, ghl_note_id, title, body')
                                .eq('person_id', person_id)
                                .eq('source', 'ghl');
                            if (fetchErr) console.error('[GHL Notes Sync] DB fetch error:', fetchErr.message);
                            const existingMap = new Map((existingGhlNotes || []).map(n => [n.ghl_note_id, n]));
                            const liveIds = new Set();

                            for (const gn of ghlNotes) {
                                const gnId = gn.id || gn._id;
                                if (!gnId) { console.warn('[GHL Notes Sync] Note missing id:', JSON.stringify(gn)); continue; }
                                liveIds.add(gnId);

                                const resolvedName = gn.userId ? (ghlUserNameMap[gn.userId] || 'GoHighLevel') : 'GoHighLevel';
                                const noteData = {
                                    title: gn.title || null,
                                    body: gn.body || gn.description || '',
                                    author_name: resolvedName,
                                    updated_at: gn.dateAdded || gn.dateUpdated || new Date().toISOString()
                                };

                                const existing = existingMap.get(gnId);
                                if (existing) {
                                    if (existing.body !== noteData.body || (existing.title || null) !== (noteData.title || null)) {
                                        const { error: upErr } = await supabase.from('partner_notes').update(noteData).eq('id', existing.id);
                                        if (upErr) console.error('[GHL Notes Sync] Update error for', gnId, upErr.message);
                                    }
                                } else {
                                    const { error: insErr } = await supabase.from('partner_notes').insert({
                                        person_id,
                                        ghl_note_id: gnId,
                                        source: 'ghl',
                                        note_type: 'general',
                                        is_pinned: false,
                                        created_at: gn.dateAdded || new Date().toISOString(),
                                        ...noteData
                                    });
                                    if (insErr) console.error('[GHL Notes Sync] Insert error for', gnId, insErr.message);
                                    else console.log('[GHL Notes Sync] Inserted note', gnId);
                                }
                            }

                            // Delete local GHL notes that were removed in GHL
                            for (const [gnId, existing] of existingMap) {
                                if (!liveIds.has(gnId)) {
                                    await supabase.from('partner_notes').delete().eq('id', existing.id);
                                    console.log('[GHL Notes Sync] Deleted stale note', gnId);
                                }
                            }
                        } else {
                            console.error('[GHL Notes Sync] HTTP', ghlRes.status, ghlRawText.slice(0, 500));
                        }
                    }
                } catch (ghlErr) {
                    console.error('[GHL Notes Sync Error]', ghlErr.message, ghlErr.stack);
                }
            } else {
                console.log('[GHL Notes Sync] No hl_contact_id provided for person_id:', person_id);
            }

            const { data, error } = await supabase
                .from('partner_notes')
                .select('*')
                .eq('person_id', person_id)
                .order('is_pinned', { ascending: false })
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        // --- ACTION: BACKFILL GHL NOTES (super admin only) ---
        if (action === 'backfill_ghl_notes') {
            const { data: actor } = await supabase.from('app_users').select('role, is_active').eq('userid', session.userid).single();
            if (!actor || actor.role !== 'super_admin' || !actor.is_active) return res.status(403).json({ success: false, message: 'Super admin only.' });

            const offset = parseInt(body.offset) || 0;
            const limit  = 15; // safe batch size within Vercel timeout

            const ghlApiKey = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
            if (!ghlApiKey) return res.status(500).json({ success: false, message: 'GHL_API_KEY not configured.' });

            // Fetch app users once for email→name resolution
            const { data: appUsers } = await supabase.from('app_users').select('email, first_name, last_name');
            const appUsersByEmail = {};
            (appUsers || []).forEach(u => {
                if (u.email) appUsersByEmail[u.email.toLowerCase()] = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email;
            });

            // Get this batch of persons with hl_contact_id
            const { data: persons, error: pErr } = await supabase
                .from('persons')
                .select('id, hl_contact_id, full_name')
                .not('hl_contact_id', 'is', null)
                .neq('hl_contact_id', '')
                .order('id')
                .range(offset, offset + limit - 1);
            if (pErr) throw pErr;

            // Count total for progress reporting
            const { count: total } = await supabase
                .from('persons')
                .select('id', { count: 'exact', head: true })
                .not('hl_contact_id', 'is', null)
                .neq('hl_contact_id', '');

            const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28', 'Accept': 'application/json' };
            const ghlUserCache = {}; // userId → display name, shared across this batch
            let inserted = 0;
            let skipped  = 0;

            for (const person of (persons || [])) {
                try {
                    const ghlRes = await fetch(`https://services.leadconnectorhq.com/contacts/${person.hl_contact_id}/notes`, { headers: ghlHeaders });
                    if (!ghlRes.ok) { skipped++; continue; }
                    const ghlData = await ghlRes.json();
                    const ghlNotes = ghlData.notes || ghlData.data || [];
                    if (!ghlNotes.length) continue;

                    // Resolve unique user IDs in this person's notes
                    const uniqueIds = [...new Set(ghlNotes.map(gn => gn.userId).filter(Boolean))];
                    for (const uid of uniqueIds) {
                        if (ghlUserCache[uid] !== undefined) continue;
                        try {
                            const uRes = await fetch(`https://services.leadconnectorhq.com/users/${uid}`, { headers: ghlHeaders });
                            if (uRes.ok) {
                                const uData = await uRes.json();
                                const ghlUser = uData.user || uData;
                                const email = (ghlUser.email || '').toLowerCase();
                                ghlUserCache[uid] = appUsersByEmail[email] || ghlUser.name || ghlUser.firstName || 'GoHighLevel';
                            } else {
                                ghlUserCache[uid] = 'GoHighLevel';
                            }
                        } catch { ghlUserCache[uid] = 'GoHighLevel'; }
                    }

                    // Load existing GHL-sourced notes for this person (avoid duplicates)
                    const { data: existing } = await supabase
                        .from('partner_notes').select('ghl_note_id')
                        .eq('person_id', person.id).eq('source', 'ghl');
                    const existingIds = new Set((existing || []).map(n => n.ghl_note_id));

                    for (const gn of ghlNotes) {
                        const gnId = gn.id || gn._id;
                        if (!gnId || existingIds.has(gnId)) continue;
                        const resolvedName = gn.userId ? (ghlUserCache[gn.userId] || 'GoHighLevel') : 'GoHighLevel';
                        const { error: insErr } = await supabase.from('partner_notes').insert({
                            person_id: person.id,
                            ghl_note_id: gnId,
                            source: 'ghl',
                            note_type: 'general',
                            is_pinned: false,
                            created_at: gn.dateAdded || new Date().toISOString(),
                            updated_at: gn.dateAdded || new Date().toISOString(),
                            title: gn.title || null,
                            body: gn.body || gn.description || '',
                            author_name: resolvedName
                        });
                        if (!insErr) inserted++;
                    }
                } catch (e) { skipped++; }
            }

            const processed = offset + (persons?.length || 0);
            return res.status(200).json({
                success: true,
                inserted,
                skipped,
                processed,
                total,
                done: processed >= total
            });
        }

        // --- ACTION: ADD PARTNER NOTE ---
        if (action === 'add_note') {
            const { person_id, body: noteBody, title: noteTitle, note_type, author_id, author_name, hl_contact_id } = body;
            if (!noteBody?.trim()) return res.status(400).json({ success: false, message: 'Note body required.' });
            if (noteBody.length > 5000) return res.status(400).json({ success: false, message: 'Note too long (max 5000 characters).' });
            const { data, error } = await supabase.from('partner_notes').insert({
                person_id, title: noteTitle?.trim() || null, body: noteBody.trim(),
                note_type: note_type || 'general', author_id, author_name, source: 'app'
            }).select().single();
            if (error) throw error;

            // Mirror to GHL
            if (hl_contact_id) {
                try {
                    const ghlApiKey = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
                    if (ghlApiKey) {
                        const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' };
                        const ghlRes = await fetch(`https://services.leadconnectorhq.com/contacts/${hl_contact_id}/notes`, {
                            method: 'POST', headers: ghlHeaders,
                            body: JSON.stringify({ userId: author_id || session.userid, title: noteTitle?.trim() || undefined, body: noteBody.trim() })
                        });
                        if (ghlRes.ok) {
                            const ghlData = await ghlRes.json();
                            const ghlNoteId = ghlData.note?.id;
                            if (ghlNoteId) {
                                await supabase.from('partner_notes').update({ ghl_note_id: ghlNoteId }).eq('id', data.id);
                                data.ghl_note_id = ghlNoteId;
                            }
                        }
                    }
                } catch (ghlErr) {
                    console.error('[GHL Add Note Error]', ghlErr.message);
                }
            }

            const pActor = await resolveActor();
            supabase.from('activity_logs').insert({
                email: pActor.email, action: `Partner note added by ${pActor.name}`,
                status: 'success', category: 'partners', target_id: person_id, target_type: 'person', severity: 'info',
                new_value: { note_type: note_type || 'general', body: noteBody.trim().slice(0, 500) }
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true, data });
        }

        // --- ACTION: UPDATE PARTNER NOTE ---
        if (action === 'update_note') {
            const { note_id, body: noteBody, title: noteTitle, is_pinned, hl_contact_id } = body;
            if (noteBody !== undefined && noteBody.length > 5000) return res.status(400).json({ success: false, message: 'Note too long (max 5000 characters).' });
            const { data: oldNote } = await supabase.from('partner_notes').select('title, body, is_pinned, person_id, ghl_note_id').eq('id', note_id).single();
            const updates = {};
            if (noteTitle !== undefined) updates.title = noteTitle.trim() || null;
            if (noteBody !== undefined) updates.body = noteBody.trim();
            if (is_pinned !== undefined) updates.is_pinned = is_pinned;
            updates.updated_at = new Date().toISOString();
            const { error } = await supabase.from('partner_notes').update(updates).eq('id', note_id);
            if (error) throw error;

            // Mirror to GHL if note has a GHL ID and content is being changed
            if (oldNote?.ghl_note_id && hl_contact_id && (noteBody !== undefined || noteTitle !== undefined)) {
                try {
                    const ghlApiKey = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
                    if (ghlApiKey) {
                        const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' };
                        await fetch(`https://services.leadconnectorhq.com/contacts/${hl_contact_id}/notes/${oldNote.ghl_note_id}`, {
                            method: 'PUT', headers: ghlHeaders,
                            body: JSON.stringify({
                                userId: session.userid,
                                title: (noteTitle !== undefined ? noteTitle.trim() : oldNote.title) || undefined,
                                body: noteBody !== undefined ? noteBody.trim() : oldNote.body
                            })
                        });
                    }
                } catch (ghlErr) {
                    console.error('[GHL Update Note Error]', ghlErr.message);
                }
            }

            const pActorUpd = await resolveActor();
            supabase.from('activity_logs').insert({
                email: pActorUpd.email, action: `Partner note updated by ${pActorUpd.name}`,
                status: 'success', category: 'partners', target_id: oldNote?.person_id || note_id, target_type: 'person', severity: 'info',
                old_value: { title: oldNote?.title, body: oldNote?.body?.slice(0, 500), is_pinned: oldNote?.is_pinned },
                new_value: { title: updates.title, body: updates.body?.slice(0, 500), is_pinned: updates.is_pinned }
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true });
        }

        // --- ACTION: DELETE PARTNER NOTE ---
        if (action === 'delete_note') {
            const { note_id, hl_contact_id } = body;
            const { data: oldNote } = await supabase.from('partner_notes').select('body, person_id, note_type, ghl_note_id').eq('id', note_id).single();

            // Delete from GHL first
            if (oldNote?.ghl_note_id && hl_contact_id) {
                try {
                    const ghlApiKey = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
                    if (ghlApiKey) {
                        const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28' };
                        await fetch(`https://services.leadconnectorhq.com/contacts/${hl_contact_id}/notes/${oldNote.ghl_note_id}`, {
                            method: 'DELETE', headers: ghlHeaders
                        });
                    }
                } catch (ghlErr) {
                    console.error('[GHL Delete Note Error]', ghlErr.message);
                }
            }

            const { error } = await supabase.from('partner_notes').delete().eq('id', note_id);
            if (error) throw error;
            const pActorDel = await resolveActor();
            supabase.from('activity_logs').insert({
                email: pActorDel.email, action: `Partner note deleted by ${pActorDel.name}`,
                status: 'success', category: 'partners', target_id: oldNote?.person_id || note_id, target_type: 'person', severity: 'warning',
                old_value: { note_type: oldNote?.note_type, body: oldNote?.body?.slice(0, 500) }
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET PARTNER SCORECARD ---
        if (action === 'get_scorecard') {
            const { person_id } = body;

            const { data: agents } = await supabase
                .from('agents')
                .select('id, company_id, companies:company_id(company_name)')
                .eq('parent_agent_id', person_id);

            if (!agents || agents.length === 0) {
                return res.status(200).json({ success: true, scorecard: null });
            }

            const agentIds = agents.map(a => a.id);
            const { data: identifiers } = await supabase
                .from('agent_identifiers')
                .select('id, agent_id, id_string, rev_share, prime49')
                .in('agent_id', agentIds);

            const idStrings = (identifiers || []).map(i => i.id_string);

            const { from_date, to_date } = body;

            let topQuery = supabase.from('merchants')
                .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_id, last_batch_date')
                .in('agent_id', idStrings)
                .eq('account_status', 'Approved')
                .order('volume_30_day', { ascending: false })
                .limit(10);

            if (from_date) topQuery = topQuery.gte('last_batch_date', from_date);
            if (to_date) topQuery = topQuery.lte('last_batch_date', to_date);

            const [statsRes, topMerchantsRes] = await Promise.all([
                supabase.from('merchant_stats_by_id')
                    .select('agent_id, merchant_count, total_volume_sum, total_volume_90d_sum, pending_count, closed_count, risk_count')
                    .in('agent_id', idStrings),
                topQuery
            ]);

            const statsMap = {};
            (statsRes.data || []).forEach(s => { statsMap[s.agent_id] = s; });

            const calcTrend = (v30, v90) => {
                const avg = v90 / 3;
                return v30 > avg * 1.05 ? 'growth' : v30 < avg * 0.95 ? 'risk' : 'stable';
            };

            // ── PER-COMPANY SCORECARD ─────────────────────────
            const companies = agents.map(agent => {
                const coName = agent.companies?.company_name || 'Independent';
                const myIds = (identifiers || []).filter(i => i.agent_id === agent.id);
                const myIdStrings = myIds.map(i => i.id_string);

                let vol30 = 0, vol90 = 0, merchants = 0, pending = 0, closed = 0, risk = 0;
                myIdStrings.forEach(id => {
                    const s = statsMap[id] || {};
                    vol30 += parseFloat(s.total_volume_sum || 0);
                    vol90 += parseFloat(s.total_volume_90d_sum || 0);
                    merchants += parseInt(s.merchant_count || 0);
                    pending += parseInt(s.pending_count || 0);
                    closed += parseInt(s.closed_count || 0);
                    risk += parseInt(s.risk_count || 0);
                });

                const topForCompany = (topMerchantsRes.data || [])
                    .filter(m => myIdStrings.includes(m.agent_id))
                    .slice(0, 5);

                return {
                    company_name: coName,
                    agent_ids: myIdStrings,
                    merchants, vol30, vol90,
                    pending, closed, at_risk: risk,
                    trend: calcTrend(vol30, vol90),
                    top_merchants: topForCompany
                };
            });

            // ── OVERALL TOTALS ────────────────────────────────
            const totals = companies.reduce((acc, c) => ({
                merchants: acc.merchants + c.merchants,
                volume_30: acc.volume_30 + c.vol30,
                volume_90: acc.volume_90 + c.vol90,
                pending: acc.pending + c.pending,
                closed: acc.closed + c.closed,
                at_risk: acc.at_risk + c.at_risk
            }), { merchants: 0, volume_30: 0, volume_90: 0, pending: 0, closed: 0, at_risk: 0 });

            totals.overall_trend = calcTrend(totals.volume_30, totals.volume_90);

            return res.status(200).json({
                success: true,
                scorecard: {
                    totals,
                    companies,
                    top_merchants: (topMerchantsRes.data || [])
                }
            });
        }


        // ── STAFF COMMUNITY FEED ──────────────────────────
        if (action === 'get_staff_name') {
            const { userid } = body;
            const { data: user } = await supabase.from('app_users')
                .select('first_name, last_name')
                .eq('userid', userid).single();
            if (!user) return res.status(200).json({ success: false });
            const name = ((user.first_name||'') + ' ' + (user.last_name||'')).trim() || 'Staff';
            return res.status(200).json({ success: true, name });
        }

        if (action === 'get_community_feed') {
            const { page = 0, category, mine_only, mine_id } = body;
            const limit = 20;
            let query = supabase.from('community_posts').select('*')
                .eq('is_deleted', false)
                .order('is_pinned', { ascending: false })
                .order('created_at', { ascending: false })
                .range(page * limit, (page + 1) * limit - 1);
            if (category) query = query.eq('category', category);
            if (mine_only && mine_id) query = query.eq('author_id', mine_id);
            const { data: posts, error: postsError } = await query;
            if (postsError) return res.status(400).json({ success: false, message: postsError.message });

            // Resolve author names
            const partnerIds = (posts||[]).filter(p => p.author_type === 'partner').map(p => p.author_id);
            const { data: persons } = partnerIds.length
                ? await supabase.from('persons').select('id, full_name').in('id', partnerIds)
                : { data: [] };
            const personMap = {};
            (persons||[]).forEach(p => { personMap[p.id] = p.full_name; });

            // Get staff names from users table if available
            const enriched = (posts||[]).map(p => {
                let displayName = p.author_name;
                if (!displayName || displayName.includes('undefined')) {
                    if (p.author_type === 'partner') displayName = personMap[p.author_id] || 'Partner';
                    else displayName = 'Staff';
                }
                return { ...p, author_name: displayName, liked_by_me: false };
            });

            return res.status(200).json({ success: true, data: enriched });
        }

        if (action === 'community_post') {
            const { body: postBody, media_urls, media_types, post_type, category, staff_name, staff_id } = body;
            if (!postBody && (!media_urls || !media_urls.length)) return res.status(400).json({ success: false, message: 'Post cannot be empty.' });
            const resolvedName = (staff_name && staff_name !== 'undefined') ? staff_name + ' (Staff)' : 'Staff';
            const { data, error } = await supabase.from('community_posts').insert({
                author_id: staff_id || 'staff',
                author_type: 'staff',
                author_name: resolvedName,
                body: postBody || '',
                media_urls: media_urls || [],
                media_types: media_types || [],
                post_type: post_type || 'text',
                category: category || 'general'
            }).select().single();
            if (error) return res.status(400).json({ success: false, message: error.message });
            return res.status(200).json({ success: true, data: { ...data, author_name: resolvedName } });
        }

        if (action === 'community_delete') {
            const { post_id, staff_id } = body;
            const { data: post } = await supabase.from('community_posts').select('author_id').eq('id', post_id).single();
            if (!post || post.author_id !== staff_id) {
                // Verify role from DB — never trust client-sent role
                const { data: actorData } = await supabase.from('app_users').select('role').eq('userid', session.userid).maybeSingle();
                if (actorData?.role !== 'super_admin') {
                    return res.status(403).json({ success: false, message: 'Not authorized.' });
                }
            }
            await supabase.from('community_posts').update({ is_deleted: true }).eq('id', post_id);
            return res.status(200).json({ success: true });
        }

        if (action === 'community_like') {
            const { post_id, staff_id } = body;
            const { data: existing } = await supabase.from('post_likes').select('id').eq('post_id', post_id).eq('author_id', staff_id).maybeSingle();
            const { data: post } = await supabase.from('community_posts').select('likes_count').eq('id', post_id).single();
            const count = post?.likes_count || 0;
            if (existing) {
                await supabase.from('post_likes').delete().eq('id', existing.id);
                await supabase.from('community_posts').update({ likes_count: Math.max(0, count - 1) }).eq('id', post_id);
                return res.status(200).json({ success: true, liked: false, count: Math.max(0, count - 1) });
            } else {
                await supabase.from('post_likes').insert({ post_id, author_id: staff_id });
                await supabase.from('community_posts').update({ likes_count: count + 1 }).eq('id', post_id);
                return res.status(200).json({ success: true, liked: true, count: count + 1 });
            }
        }

        if (action === 'community_comments') {
            const { post_id } = body;
            const { data } = await supabase.from('post_comments').select('*').eq('post_id', post_id).order('created_at', { ascending: true });
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'community_comment') {
            const { post_id, body: commentBody, staff_name, staff_id } = body;
            if (!commentBody?.trim()) return res.status(400).json({ success: false, message: 'Comment empty.' });
            const { data, error } = await supabase.from('post_comments').insert({
                post_id, author_id: staff_id || 'staff',
                author_name: (staff_name || 'Staff') + ' (Staff)',
                body: commentBody.trim()
            }).select().single();
            if (error) return res.status(400).json({ success: false, message: error.message });
            const { data: p } = await supabase.from('community_posts').select('comments_count').eq('id', post_id).single();
            await supabase.from('community_posts').update({ comments_count: (p?.comments_count||0)+1 }).eq('id', post_id);
            return res.status(200).json({ success: true, data });
        }

        if (action === 'community_upload') {
            const { file_base64, file_name, content_type, staff_id } = body;
            if (!file_base64) return res.status(400).json({ success: false, message: 'No file.' });
            const buffer = Buffer.from(file_base64, 'base64');
            const path = (staff_id || 'staff') + '/' + Date.now() + '_' + file_name;
            const { error } = await supabase.storage.from('partner-media').upload(path, buffer, { contentType: content_type, upsert: true });
            if (error) return res.status(400).json({ success: false, message: error.message });
            const { data: urlData } = supabase.storage.from('partner-media').getPublicUrl(path);
            return res.status(200).json({ success: true, url: urlData.publicUrl, type: content_type.startsWith('video') ? 'video' : 'image' });
        }

        if (action === 'community_members') {
            const { data } = await supabase.from('persons').select('id, full_name').eq('is_portal_active', true).order('full_name').limit(50);
            return res.status(200).json({ success: true, data: data || [] });
        }

        // --- ACTION: SEARCH BY MID ---
if (action === 'search_by_mid') {
    const { mid } = body;
    const { data, error } = await supabase
        .from('merchants')
        .select('agent_id')
        .eq('merchant_id', mid)
        .limit(1);

    if (error) return res.status(500).json({ success: false });
    return res.status(200).json({ success: true, agent_id: data[0]?.agent_id });
}

// --- ACTION: GET MERCHANT DATA (Using High-Speed View) ---
if (action === 'get_merchant_data') {
    const { identifier_ids } = body;
    try {
        const { data: stats, error } = await supabase
            .from('merchant_stats_by_id')
            .select('*')
            .in('agent_id', identifier_ids); // identifier_ids must be an array of strings

        if (error) throw error;
        
        // Log this to your server console to see if the DB is returning more than 1
        console.log("Stats returned from DB:", stats);

        return res.status(200).json({ success: true, data: stats });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
        // --- ACTION: MOVE IDENTIFIER (Legacy/Single Update) ---
        if (action === 'move_identifier') {
            const { identifier_id, new_parent_id } = body;

            if (identifier_id === new_parent_id) {
                return res.status(400).json({ success: false, message: "ID cannot be its own parent." });
            }

            const parentId = (!new_parent_id || new_parent_id === "" || new_parent_id === "null") 
                ? null 
                : new_parent_id;

            const { error } = await supabase
                .from('agent_identifiers')
                .update({ parent_config_id: parentId })
                .eq('id', identifier_id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }
        if (action === 'update_identifier_all') {
    const { id, rev_share, prime49, new_parent_id } = body;

    // Fetch old values for audit trail before updating
    const { data: oldData } = await supabase
        .from('agent_identifiers')
        .select('id_string, rev_share, prime49, parent_config_id')
        .eq('id', id)
        .single();

    const { error } = await supabase
        .from('agent_identifiers')
        .update({ rev_share, prime49, parent_config_id: new_parent_id })
        .eq('id', id);

    // Build human-readable change summary
    const changes = [];
    if (String(oldData?.rev_share) !== String(rev_share)) changes.push(`rev_share: ${oldData?.rev_share} → ${rev_share}`);
    if (oldData?.prime49 !== prime49) changes.push(`prime49: ${oldData?.prime49} → ${prime49}`);
    if (oldData?.parent_config_id !== new_parent_id) changes.push(`parent: ${oldData?.parent_config_id || 'none'} → ${new_parent_id || 'none'}`);

    const actor = await resolveActor();
    await supabase.from('activity_logs').insert([{
        email: actor.email,
        action: `Agent ID Updated: ${oldData?.id_string || id}`,
        status: error ? 'failure' : 'success',
        category: 'partners',
        target_id: id,
        target_type: 'agent_identifier',
        severity: (oldData?.prime49 !== prime49 || String(oldData?.rev_share) !== String(rev_share)) ? 'warning' : 'info',
        old_value: { id_string: oldData?.id_string, rev_share: oldData?.rev_share, prime49: oldData?.prime49, parent_config_id: oldData?.parent_config_id },
        new_value: { rev_share, prime49, parent_config_id: new_parent_id, changes: changes.join(' | ') || 'no changes', error: error?.message || null },
        user_agent: req.headers['user-agent'],
        ip_address: req.headers['x-forwarded-for'] || 'Internal'
    }]);

    // ── PRIME49 TASK AUTOMATION: fire-and-forget on prime49 flag change ────────
    if (!error && oldData && oldData.prime49 !== prime49 && oldData.id_string) {
        const _idString = oldData.id_string;
        const _session  = session;

        if (prime49 === true) {
            // Converted TO prime49 → create tasks for ALL merchants on this ID
            (async () => {
                try {
                    const { data: cfg } = await supabase
                        .from('prime49_task_automation_config')
                        .select('*').eq('id', 1).maybeSingle();
                    if (!cfg || !cfg.enabled) return;

                    const { data: mRows } = await supabase
                        .from('merchants')
                        .select('id, merchant_id, dba_name, agent_id, agent_name, enrollment_date, account_status')
                        .eq('agent_id', _idString)
                        .limit(5000);
                    if (!mRows || !mRows.length) return;

                    const tpl = (t, m) => (t || '')
                        .replace(/\{\{dba_name\}\}/gi,        m.dba_name        || '—')
                        .replace(/\{\{mid\}\}/gi,             m.merchant_id     || '—')
                        .replace(/\{\{agent_id\}\}/gi,        m.agent_id        || '—')
                        .replace(/\{\{partner_name\}\}/gi,    m.agent_name      || '—')
                        .replace(/\{\{enrollment_date\}\}/gi, m.enrollment_date || '—')
                        .replace(/\{\{account_status\}\}/gi,  m.account_status  || '—');

                    const tasks = mRows.map(m => ({
                        title:       tpl(cfg.task_title_template, m),
                        body:        tpl(cfg.task_description_template, m),
                        priority:    cfg.priority || 'Normal',
                        status:      'Pending',
                        merchant_id: m.id,
                        assigned_to: cfg.assignee_id || null,
                        created_by:  _session.userid,
                        source:      'prime49_auto'
                    }));

                    const CHUNK = 500;
                    for (let i = 0; i < tasks.length; i += CHUNK) {
                        const { error: tErr } = await supabase.from('merchant_tasks').insert(tasks.slice(i, i + CHUNK));
                        if (tErr) console.warn('[prime49-auto] Task insert error:', tErr.message);
                    }
                    console.log(`[prime49-auto] ID ${_idString} → prime49: created ${tasks.length} task(s)`);
                } catch (e) { console.warn('[prime49-auto] Conversion error:', e.message); }
            })();

        } else {
            // Reverted FROM prime49 → delete all Pending auto-created tasks for this ID's merchants
            (async () => {
                try {
                    const { data: mRows } = await supabase
                        .from('merchants')
                        .select('id')
                        .eq('agent_id', _idString)
                        .limit(5000);
                    if (!mRows || !mRows.length) return;

                    const uuids = mRows.map(m => m.id);
                    const CHUNK = 500;
                    let deleted = 0;
                    for (let i = 0; i < uuids.length; i += CHUNK) {
                        const { count } = await supabase
                            .from('merchant_tasks')
                            .delete({ count: 'exact' })
                            .in('merchant_id', uuids.slice(i, i + CHUNK))
                            .eq('source', 'prime49_auto')
                            .eq('status', 'Pending');
                        deleted += (count || 0);
                    }
                    console.log(`[prime49-auto] ID ${_idString} → normal: deleted ${deleted} pending task(s)`);
                } catch (e) { console.warn('[prime49-auto] Revert error:', e.message); }
            })();
        }
    }

    return res.status(200).json({ success: !error, message: error?.message });
}

        // --- ACTION: MOVE IDENTIFIER TO ANOTHER COMPANY ---
        if (action === 'move_identifier_to_company') {
            const { identifier_id, target_agent_id, target_company_id, clear_parent } = body;
            if (!identifier_id || (!target_agent_id && !target_company_id)) {
                return res.status(400).json({ success: false, message: 'Missing identifier_id or target_company_id' });
            }

            const INDEPENDENT_PLACEHOLDER = 'f1ed4ff6-a7ee-4658-9684-a1ae7cc275be';

            // Get the identifier's current agent
            const { data: identRow, error: e1 } = await supabase
                .from('agent_identifiers').select('agent_id').eq('id', identifier_id).single();
            if (e1) throw e1;
            const sourceAgentId = identRow.agent_id;

            let destAgentId;

            if (target_agent_id === INDEPENDENT_PLACEHOLDER) {
                // Make independent: move to null-company agent for the same person
                const { data: srcAgentI } = await supabase
                    .from('agents').select('parent_agent_id').eq('id', sourceAgentId).single();
                const personId = srcAgentI ? srcAgentI.parent_agent_id : null;
                if (personId) {
                    // Check if this person already has a null-company agent
                    const { data: existNull } = await supabase.from('agents').select('id')
                        .eq('parent_agent_id', personId).is('company_id', null).neq('id', INDEPENDENT_PLACEHOLDER).maybeSingle();
                    destAgentId = existNull ? existNull.id : INDEPENDENT_PLACEHOLDER;
                    if (!existNull) {
                        // Create a dedicated null-company agent for this person
                        const { data: personRow } = await supabase.from('persons').select('full_name').eq('id', personId).single();
                        const { data: na } = await supabase.from('agents')
                            .insert({ parent_agent_id: personId, company_id: null, agent_name: personRow?.full_name || '' }).select('id').single();
                        if (na) destAgentId = na.id;
                    }
                } else {
                    destAgentId = INDEPENDENT_PLACEHOLDER;
                }
            } else {
                // Move to a specific company — ID stays with the same person
                const destCompanyId = target_company_id;

                const { data: srcAgent, error: e2 } = await supabase
                    .from('agents').select('parent_agent_id').eq('id', sourceAgentId).single();
                if (e2) throw e2;

                const { data: existing } = await supabase
                    .from('agents').select('id')
                    .eq('parent_agent_id', srcAgent.parent_agent_id)
                    .eq('company_id', destCompanyId)
                    .maybeSingle();

                if (existing) {
                    destAgentId = existing.id;
                } else {
                    const { data: personRow } = await supabase.from('persons').select('full_name').eq('id', srcAgent.parent_agent_id).single();
                    const { data: newAgent, error: e4 } = await supabase
                        .from('agents')
                        .insert({ parent_agent_id: srcAgent.parent_agent_id, company_id: destCompanyId, agent_name: personRow?.full_name || '' })
                        .select('id').single();
                    if (e4) throw e4;
                    destAgentId = newAgent.id;
                }
            }

            // Move the identifier to the destination agent
            // Only clear parent_config_id if explicitly requested (independent mode + user opted in)
            const updatePayload = { agent_id: destAgentId };
            if (clear_parent) updatePayload.parent_config_id = null;
            const { error: e5 } = await supabase
                .from('agent_identifiers')
                .update(updatePayload)
                .eq('id', identifier_id);
            if (e5) throw e5;

            // Clean up the source agent if it now has no identifiers left
            if (sourceAgentId !== INDEPENDENT_PLACEHOLDER && sourceAgentId !== destAgentId) {
                const { data: remaining } = await supabase
                    .from('agent_identifiers').select('id').eq('agent_id', sourceAgentId).limit(1);
                if (remaining && remaining.length === 0) {
                    await supabase.from('agents').delete().eq('id', sourceAgentId);
                }
            }

            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET ALL STATS (for page-level trend calculation) ---
if (action === 'get_all_stats') {
    try {
        const { data, error } = await supabase
            .from('merchant_stats_by_id')
            .select('agent_id, total_volume_sum, total_volume_90d_sum, merchant_count, pending_count, closed_count, risk_count')
            .limit(5000);
        if (error) throw error;
        return res.status(200).json({ success: true, data: data || [] });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

        // --- ACTION: GET PARTNERS LIST (Added Email, Phone, and HL ID) ---
        if (action === 'get_partners_list') {
            async function fetchAll(table, select) {
                let allData = [];
                let from = 0;
                let finished = false;
                while (!finished) {
                    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
                    if (error || !data || data.length === 0) { finished = true; }
                    else {
                        allData = allData.concat(data);
                        from += 1000;
                        if (data.length < 1000) finished = true;
                    }
                }
                return allData;
            }

            const [persons, agents, identifiers, companies] = await Promise.all([
                // UPDATED SELECT STRING BELOW
                fetchAll('persons', 'id, full_name, email, phone_number, hl_contact_id, enrolled_at, is_portal_active, portal_password_set, last_portal_login, is_branded'),
                fetchAll('agents', 'id, company_id, parent_agent_id'),
                fetchAll('agent_identifiers', 'id, agent_id, id_string, rev_share, prime49, parent_config_id'),
                fetchAll('companies', 'id, company_name')
            ]);

            return res.status(200).json({ 
                success: true, 
                data: { persons, agents, identifiers, companies } 
            });
        }

 // Inside partners.js
if (action === 'get_merchant_data_raw') {
    const { identifier_id } = body;
    
    // Paginate to get ALL merchants (Supabase default cap is 1000)
    let allMerchants = [];
    let from = 0;
    let done = false;
    while (!done) {
        const { data, error } = await supabase
            .from('merchants')
            .select('merchant_id, dba_name, account_status, enrollment_date, volume_30_day, volume_90_day, volume_mtd, last_batch_date, merchant_city, merchant_state, merchant_phone, email')
            .eq('agent_id', identifier_id)
            .range(from, from + 999);
        if (error || !data || data.length === 0) { done = true; }
        else {
            allMerchants = allMerchants.concat(data);
            if (data.length < 1000) done = true;
            else from += 1000;
        }
    }
    return res.status(200).json({ success: true, data: allMerchants, total: allMerchants.length });
}
        if (action === 'send_risk_alert') {
    const { agent_id_string, merchants, sender_name } = body;
    if (!agent_id_string || !merchants?.length) {
        return res.status(400).json({ success: false, message: 'agent_id_string and merchants required.' });
    }

    // Resolve agent_id_string → person
    const { data: identRec } = await supabase
        .from('agent_identifiers')
        .select('agent_id')
        .eq('id_string', agent_id_string)
        .single();
    if (!identRec) return res.status(404).json({ success: false, message: 'Agent identifier not found.' });

    const { data: agentRec } = await supabase
        .from('agents')
        .select('parent_agent_id')
        .eq('id', identRec.agent_id)
        .single();
    if (!agentRec?.parent_agent_id) return res.status(404).json({ success: false, message: 'Agent has no linked person.' });

    const { data: person } = await supabase
        .from('persons')
        .select('id, full_name, email, is_portal_active, portal_password_set')
        .eq('id', agentRec.parent_agent_id)
        .single();
    if (!person) return res.status(404).json({ success: false, message: 'Person not found.' });

    const partnerName = person.full_name || 'Partner';
    const atRisk = merchants.filter(m => m.impact < 0);
    if (!atRisk.length) return res.status(200).json({ success: true, message: 'No at-risk merchants.' });

    // Build email HTML
    const rowsHtml = atRisk.map(m => `
        <tr>
            <td style="padding:10px 12px; border-bottom:1px solid #f1f5f9;">
                <div style="font-weight:700; font-size:13px; color:#002d5a;">${m.dba}</div>
                <div style="font-size:11px; color:#94a3b8;">MID: ${m.mid}</div>
            </td>
            <td style="padding:10px 12px; border-bottom:1px solid #f1f5f9; font-size:12px; color:#64748b; text-align:center;">${m.lastBatch}</td>
            <td style="padding:10px 12px; border-bottom:1px solid #f1f5f9; font-size:12px; text-align:right;">$${Number(m.baseline).toLocaleString(undefined, {maximumFractionDigits:0})}</td>
            <td style="padding:10px 12px; border-bottom:1px solid #f1f5f9; font-size:12px; text-align:right;">$${Number(m.current).toLocaleString(undefined, {maximumFractionDigits:0})}</td>
            <td style="padding:10px 12px; border-bottom:1px solid #f1f5f9; font-size:12px; font-weight:800; color:#ef4444; text-align:right; background:#fef2f2;">$${Math.abs(Number(m.impact)).toLocaleString(undefined, {maximumFractionDigits:0})} down</td>
        </tr>`).join('');

    const emailHtml = `
        <div style="font-family:'Inter',Arial,sans-serif;max-width:600px;margin:auto;padding:32px;border:1px solid #e2e8f0;border-radius:16px;color:#1e293b;background:#ffffff;">
            <div style="text-align:center;margin-bottom:24px;">
                <h2 style="color:#004990;margin:0;font-size:22px;">PayProTec</h2>
                <p style="color:#64748b;font-size:12px;margin:4px 0 0;">Partner Risk Alert</p>
            </div>
            <p style="font-size:14px;margin-bottom:8px;">Hi <strong>${partnerName}</strong>,</p>
            <p style="font-size:13px;color:#475569;margin-bottom:20px;">
                We've identified ${atRisk.length === 1 ? 'a merchant in your portfolio' : `${atRisk.length} merchants in your portfolio`} showing a significant decline in processing volume compared to their 90-day average. Please review and reach out to these accounts if needed.
            </p>
            <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
                <thead>
                    <tr style="background:#f8fafc;">
                        <th style="padding:10px 12px;font-size:10px;color:#94a3b8;text-transform:uppercase;text-align:left;">Merchant</th>
                        <th style="padding:10px 12px;font-size:10px;color:#94a3b8;text-transform:uppercase;text-align:center;">Last Batch</th>
                        <th style="padding:10px 12px;font-size:10px;color:#94a3b8;text-transform:uppercase;text-align:right;">Avg (90d)</th>
                        <th style="padding:10px 12px;font-size:10px;color:#94a3b8;text-transform:uppercase;text-align:right;">Current</th>
                        <th style="padding:10px 12px;font-size:10px;color:#94a3b8;text-transform:uppercase;text-align:right;">Variance</th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
            <p style="font-size:12px;color:#94a3b8;margin-top:24px;text-align:center;">
                This alert was generated by ${sender_name || 'PayProTec Staff'}. Please log in to your partner portal for more details.
            </p>
        </div>`;

    const textBody = `Hi ${partnerName},\n\nThe following merchants in your portfolio are showing a volume decline:\n\n` +
        atRisk.map(m => `- ${m.dba} (MID: ${m.mid}): $${Number(m.impact).toLocaleString(undefined, {maximumFractionDigits:0})} variance`).join('\n') +
        `\n\nPlease reach out to these accounts if needed.\n\n— ${sender_name || 'PayProTec Staff'}`;

    if (person.email) {
        await sendEmail(
            person.email,
            `⚠️ Risk Alert: ${atRisk.length === 1 ? atRisk[0].dba : `${atRisk.length} merchants`} showing volume decline`,
            emailHtml,
            textBody
        );
    }

    // Portal notification if active
    if (person.is_portal_active && person.portal_password_set) {
        await supabase.from('notifications').insert({
            recipient_id: String(person.id),
            recipient_type: 'partner',
            type: 'risk_alert',
            title: `⚠️ Risk Alert: ${atRisk.length} merchant${atRisk.length > 1 ? 's' : ''} need attention`,
            body: atRisk.map(m => `${m.dba}: $${Number(m.impact).toLocaleString(undefined, {maximumFractionDigits:0})} variance`).join(' | '),
            actor_name: sender_name || 'PayProTec Staff',
            link: '/partner/merchants',
            is_read: false
        });
    }

    return res.status(200).json({ success: true, emailed: !!person.email, portal: !!(person.is_portal_active && person.portal_password_set) });
}

        // --- ACTION: GET LEADERBOARD ---
        if (action === 'get_leaderboard') {
            // Single query against pre-aggregated materialized view — O(1) regardless of dataset size
            const { data: rows, error: lvErr } = await supabase
                .from('partner_leaderboard_mv')
                .select('person_id, name, merchant_count, volume_30_day, volume_90_day')
                .order('volume_30_day', { ascending: false });

            if (lvErr) throw lvErr;

            const ranked = (rows || []).map((p, i) => {
                const rank = i + 1;
                const tier = rank <= 3 ? 'Gold' : rank <= 10 ? 'Silver' : 'Bronze';
                const vol30 = parseFloat(p.volume_30_day) || 0;
                const vol90 = parseFloat(p.volume_90_day) || 0;
                const baseline = vol90 / 3;
                let growth_pct = 0;
                if (baseline > 0) {
                    growth_pct = ((vol30 - baseline) / baseline) * 100;
                    if (growth_pct > 999) growth_pct = 999;
                    growth_pct = Math.round(growth_pct * 10) / 10;
                }
                return { ...p, volume_30_day: vol30, volume_90_day: vol90, rank, tier, growth_pct };
            });

            const needsAttention = ranked.filter(p => p.growth_pct < -10).slice(0, 10);
            const allRanks = ranked.map(r => ({ person_id: r.person_id, rank: r.rank, tier: r.tier }));
            return res.status(200).json({ success: true, data: ranked.slice(0, 20), needs_attention: needsAttention, ranks: allRanks, total: ranked.length });
        }

        if (action === 'refresh_leaderboard') {
            const { error: rfErr } = await supabase.rpc('refresh_leaderboard_mv');
            if (rfErr) throw rfErr;
            return res.status(200).json({ success: true, message: 'Leaderboard refreshed.' });
        }

        // --- ACTION: GET API USAGE ---
        if (action === 'get_api_usage') {
            const { token: partnerToken } = body;
            if (!partnerToken) return res.status(401).json({ success: false, message: 'Token required.' });

            // Resolve partner token → person_id
            const { data: sessionData } = await supabase
                .from('partner_sessions')
                .select('person_id, expires_at')
                .eq('session_token', partnerToken)
                .single();

            if (!sessionData || new Date(sessionData.expires_at) < new Date()) {
                return res.status(401).json({ success: false, message: 'Invalid or expired session.' });
            }

            const personId = sessionData.person_id;

            // Fetch all api_keys owned by this partner
            const { data: keys } = await supabase
                .from('api_keys')
                .select('id, tier')
                .eq('owner_id', personId);

            if (!keys || keys.length === 0) {
                return res.status(200).json({
                    success: true,
                    data: {
                        tier: 'free',
                        daily_limit: 500,
                        monthly_limit: 15000,
                        calls_today: 0,
                        calls_this_month: 0,
                        top_endpoints: [],
                        calls_by_day: []
                    }
                });
            }

            const keyIds = keys.map(k => k.id);
            // Use the highest tier among all keys
            const TIER_RANK = { free: 0, standard: 1, enterprise: 2 };
            const TIER_LIMITS = {
                free:       { daily_limit: 500,   monthly_limit: 15000  },
                standard:   { daily_limit: 5000,  monthly_limit: 150000 },
                enterprise: { daily_limit: 50000, monthly_limit: 1500000 }
            };
            const topTier = keys.reduce((best, k) => {
                const tier = k.tier || 'free';
                return (TIER_RANK[tier] || 0) > (TIER_RANK[best] || 0) ? tier : best;
            }, 'free');
            const limits = TIER_LIMITS[topTier] || TIER_LIMITS.free;

            // Date ranges
            const now = new Date();
            const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
            const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

            // Fetch usage logs (last 30 days) — graceful if table absent
            let logs = [];
            try {
                const { data: rawLogs, error: logsErr } = await supabase
                    .from('api_usage_log')
                    .select('api_key_id, endpoint, created_at')
                    .in('api_key_id', keyIds)
                    .gte('created_at', thirtyDaysAgo.toISOString())
                    .order('created_at', { ascending: false })
                    .limit(10000);
                if (!logsErr) logs = rawLogs || [];
            } catch (e) {
                // Table may not exist — return zeros gracefully
            }

            const calls_today = logs.filter(l => new Date(l.created_at) >= startOfDay).length;
            const calls_this_month = logs.filter(l => new Date(l.created_at) >= startOfMonth).length;

            // Top 5 endpoints
            const endpointCounts = {};
            logs.forEach(l => {
                const ep = (l.endpoint || '/unknown').split('?')[0];
                endpointCounts[ep] = (endpointCounts[ep] || 0) + 1;
            });
            const top_endpoints = Object.entries(endpointCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([endpoint, count]) => ({ endpoint, count }));

            // Calls by day — last 7 days
            const calls_by_day = [];
            for (let i = 6; i >= 0; i--) {
                const dayStart = new Date(now);
                dayStart.setDate(dayStart.getDate() - i);
                dayStart.setHours(0, 0, 0, 0);
                const dayEnd = new Date(dayStart);
                dayEnd.setDate(dayEnd.getDate() + 1);
                const count = logs.filter(l => {
                    const t = new Date(l.created_at);
                    return t >= dayStart && t < dayEnd;
                }).length;
                const label = dayStart.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                calls_by_day.push({ date: dayStart.toISOString().slice(0, 10), label, count });
            }

            return res.status(200).json({
                success: true,
                data: {
                    tier: topTier,
                    daily_limit: limits.daily_limit,
                    monthly_limit: limits.monthly_limit,
                    calls_today,
                    calls_this_month,
                    top_endpoints,
                    calls_by_day
                }
            });
        }

        // --- ACTION: GET HIERARCHY ---
        if (action === 'get_hierarchy') {
            const { data: masters } = await supabase.from('agents').select('id').eq('parent_agent_id', person_id);
            const masterIds = (masters || []).map(a => a.id);

            const { data: subAgents, error } = await supabase
                .from('agents')
                .select(`agent_name, agent_identifiers (id_string, rev_share)`)
                .in('parent_agent_id', masterIds);

            if (error) throw error;
            return res.status(200).json({ success: true, data: subAgents || [] });
        }

        // ── PARTNER-PORTAL: RESOLVE SESSION PERSON ───────────────────────────
        // Helper used by the partner-facing sub-partner actions below.
        // The token comes in body.token (same pattern as partner-data.js).
        async function resolvePartnerPersonId() {
            const { token: partnerToken } = body;
            if (!partnerToken) return null;
            const { data: sess } = await supabase
                .from('partner_sessions')
                .select('person_id, expires_at')
                .eq('session_token', partnerToken)
                .single();
            if (!sess || new Date(sess.expires_at) < new Date()) return null;
            return sess.person_id;
        }

        // --- ACTION: GET SUB-PARTNERS (partner-portal) ---
        if (action === 'get_sub_partners') {
            const myPersonId = await resolvePartnerPersonId();
            if (!myPersonId) return res.status(401).json({ success: false, message: 'Session expired.' });

            // 1. Get all agents belonging to this partner
            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', myPersonId);
            if (!myAgents || !myAgents.length) return res.status(200).json({ success: true, data: [] });
            const myAgentIds = myAgents.map(a => a.id);

            // 2. Get all identifiers for this partner's agents
            const { data: myIdentifiers } = await supabase.from('agent_identifiers').select('id').in('agent_id', myAgentIds);
            if (!myIdentifiers || !myIdentifiers.length) return res.status(200).json({ success: true, data: [] });
            const myIdentifierIds = myIdentifiers.map(i => i.id);

            // 3. Find all identifiers whose parent_config_id points to one of this partner's identifiers
            const { data: subIdentifiers } = await supabase
                .from('agent_identifiers')
                .select('id, agent_id, id_string, rev_share')
                .in('parent_config_id', myIdentifierIds);
            if (!subIdentifiers || !subIdentifiers.length) return res.status(200).json({ success: true, data: [] });

            const subAgentIds = [...new Set(subIdentifiers.map(i => i.agent_id))];

            // 4. Get the agents for those sub-partner identifiers, then get persons
            const { data: subAgents } = await supabase.from('agents').select('id, parent_agent_id').in('id', subAgentIds);
            if (!subAgents || !subAgents.length) return res.status(200).json({ success: true, data: [] });
            const subPersonIds = [...new Set(subAgents.filter(a => a.parent_agent_id).map(a => a.parent_agent_id))];

            const { data: subPersons } = await supabase
                .from('persons')
                .select('id, full_name, email, is_portal_active')
                .in('id', subPersonIds);
            if (!subPersons || !subPersons.length) return res.status(200).json({ success: true, data: [] });

            // Build agent_id → person_id map
            const agentToPersonMap = {};
            subAgents.forEach(a => { agentToPersonMap[a.id] = a.parent_agent_id; });

            // Build person → sub-identifiers map (include UUID for rev share editing)
            const personIdentMap = {};
            subIdentifiers.forEach(si => {
                const pid = agentToPersonMap[si.agent_id];
                if (!pid) return;
                if (!personIdentMap[pid]) personIdentMap[pid] = [];
                personIdentMap[pid].push({ id: si.id, id_string: si.id_string, rev_share: si.rev_share });
            });

            // 5. For each sub-partner person, get merchant count and volume
            const allSubIdStrings = subIdentifiers.map(i => i.id_string);
            let merchantRows = [];
            const CHUNK = 500;
            for (let i = 0; i < allSubIdStrings.length; i += CHUNK) {
                const chunk = allSubIdStrings.slice(i, i + CHUNK);
                const { data: mChunk } = await supabase
                    .from('merchants')
                    .select('agent_id, volume_30_day')
                    .in('agent_id', chunk);
                if (mChunk) merchantRows = merchantRows.concat(mChunk);
            }

            // Map id_string → person_id
            const idStringToPersonId = {};
            subIdentifiers.forEach(si => {
                const pid = agentToPersonMap[si.agent_id];
                if (pid) idStringToPersonId[si.id_string] = pid;
            });

            const personMerchStats = {};
            merchantRows.forEach(m => {
                const pid = idStringToPersonId[m.agent_id];
                if (!pid) return;
                if (!personMerchStats[pid]) personMerchStats[pid] = { merchant_count: 0, volume_30_day: 0 };
                personMerchStats[pid].merchant_count++;
                personMerchStats[pid].volume_30_day += parseFloat(m.volume_30_day || 0);
            });

            const result = subPersons.map(p => ({
                person_id: p.id,
                full_name: p.full_name,
                email: p.email,
                is_portal_active: p.is_portal_active,
                agent_ids: personIdentMap[p.id] || [],
                merchant_count: personMerchStats[p.id]?.merchant_count || 0,
                volume_30_day: personMerchStats[p.id]?.volume_30_day || 0
            }));

            return res.status(200).json({ success: true, data: result });
        }

        // --- ACTION: GET SUB-PARTNER MERCHANTS (partner-portal) ---
        if (action === 'get_sub_partner_merchants') {
            const myPersonId = await resolvePartnerPersonId();
            if (!myPersonId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { sub_person_id } = body;
            if (!sub_person_id) return res.status(400).json({ success: false, message: 'sub_person_id required.' });

            // Security: verify sub_person_id is actually a sub-partner of the current partner
            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', myPersonId);
            if (!myAgents || !myAgents.length) return res.status(403).json({ success: false, message: 'Access denied.' });
            const myAgentIds = myAgents.map(a => a.id);

            const { data: myIdentifiers } = await supabase.from('agent_identifiers').select('id').in('agent_id', myAgentIds);
            if (!myIdentifiers || !myIdentifiers.length) return res.status(403).json({ success: false, message: 'Access denied.' });
            const myIdentifierIds = myIdentifiers.map(i => i.id);

            // Get the sub-partner's agents
            const { data: subAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', sub_person_id);
            if (!subAgents || !subAgents.length) return res.status(200).json({ success: true, data: [] });
            const subAgentIds = subAgents.map(a => a.id);

            // Get the sub-partner's identifiers
            const { data: subIdentifiers } = await supabase
                .from('agent_identifiers')
                .select('id, id_string, parent_config_id')
                .in('agent_id', subAgentIds);
            if (!subIdentifiers || !subIdentifiers.length) return res.status(200).json({ success: true, data: [] });

            // Verify at least one sub-identifier has parent_config_id in myIdentifierIds
            const isSubPartner = subIdentifiers.some(si => myIdentifierIds.includes(si.parent_config_id));
            if (!isSubPartner) return res.status(403).json({ success: false, message: 'Access denied: not a sub-partner of yours.' });

            const subIdStrings = subIdentifiers.map(i => i.id_string);

            // Get merchants
            let allMerchants = [];
            const CHUNK = 500;
            for (let i = 0; i < subIdStrings.length; i += CHUNK) {
                const chunk = subIdStrings.slice(i, i + CHUNK);
                const { data: mChunk } = await supabase
                    .from('merchants')
                    .select('merchant_id, dba_name, account_status, volume_30_day, enrollment_date')
                    .in('agent_id', chunk)
                    .order('dba_name');
                if (mChunk) allMerchants = allMerchants.concat(mChunk);
            }

            return res.status(200).json({ success: true, data: allMerchants });
        }

        // --- ACTION: RESOLVE IDENTIFIER ID (partner-portal helper) ---
        if (action === 'resolve_identifier_id') {
            const myPersonId = await resolvePartnerPersonId();
            if (!myPersonId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { id_string: lookupIdString } = body;
            if (!lookupIdString) return res.status(400).json({ success: false, message: 'id_string required.' });

            // Only return if it belongs to this partner
            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', myPersonId);
            const myAgentIds = (myAgents || []).map(a => a.id);

            const { data: ident } = await supabase
                .from('agent_identifiers')
                .select('id, agent_id')
                .eq('id_string', lookupIdString)
                .in('agent_id', myAgentIds.length ? myAgentIds : ['__none__'])
                .maybeSingle();

            if (!ident) return res.status(403).json({ success: false, message: 'Identifier not found or does not belong to you.' });
            return res.status(200).json({ success: true, identifier_id: ident.id });
        }

        // --- ACTION: INVITE SUB-PARTNER (partner-portal) ---
        if (action === 'invite_sub_partner') {
            const myPersonId = await resolvePartnerPersonId();
            if (!myPersonId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { email, full_name, agent_id_string, rev_share, parent_identifier_id, parent_id_string } = body;
            if (!email || !full_name || !agent_id_string || (!parent_identifier_id && !parent_id_string)) {
                return res.status(400).json({ success: false, message: 'email, full_name, agent_id_string, and parent_identifier_id are required.' });
            }

            // Verify parent identifier belongs to the current partner
            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', myPersonId);
            if (!myAgents || !myAgents.length) return res.status(403).json({ success: false, message: 'Access denied.' });
            const myAgentIds = myAgents.map(a => a.id);

            // Resolve parent identifier — prefer UUID, fall back to id_string lookup
            let resolvedParentIdentId = parent_identifier_id;
            if (!resolvedParentIdentId && parent_id_string) {
                const { data: foundIdent } = await supabase
                    .from('agent_identifiers')
                    .select('id, agent_id')
                    .eq('id_string', parent_id_string)
                    .in('agent_id', myAgentIds)
                    .maybeSingle();
                if (!foundIdent) return res.status(403).json({ success: false, message: 'Parent identifier not found or does not belong to you.' });
                resolvedParentIdentId = foundIdent.id;
            }

            const { data: parentIdent } = await supabase
                .from('agent_identifiers')
                .select('id, agent_id')
                .eq('id', resolvedParentIdentId)
                .single();
            if (!parentIdent || !myAgentIds.includes(parentIdent.agent_id)) {
                return res.status(403).json({ success: false, message: 'Access denied: identifier does not belong to you.' });
            }
            const finalParentIdentId = resolvedParentIdentId;

            // Validate uniqueness
            const { data: existingPerson } = await supabase.from('persons').select('id').eq('email', email.toLowerCase().trim()).maybeSingle();
            if (existingPerson) return res.status(400).json({ success: false, message: 'A partner with this email already exists.' });

            const { data: existingIdent } = await supabase.from('agent_identifiers').select('id').eq('id_string', agent_id_string.trim()).maybeSingle();
            if (existingIdent) return res.status(400).json({ success: false, message: 'This Agent ID string is already in use.' });

            // Create person
            const properName = full_name.trim().toLowerCase().split(' ').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
            const { data: newPerson, error: personErr } = await supabase
                .from('persons')
                .insert({ full_name: properName, email: email.toLowerCase().trim(), is_portal_active: true, enrolled_at: new Date().toISOString() })
                .select().single();
            if (personErr) return res.status(400).json({ success: false, message: 'Failed to create partner: ' + personErr.message });

            // Create agent
            const { data: newAgent, error: agentErr } = await supabase
                .from('agents')
                .insert({ agent_name: properName, parent_agent_id: newPerson.id })
                .select().single();
            if (agentErr) return res.status(400).json({ success: false, message: 'Failed to create agent: ' + agentErr.message });

            // Create agent_identifiers record
            const { error: identErr } = await supabase.from('agent_identifiers').insert({
                agent_id: newAgent.id,
                id_string: agent_id_string.trim(),
                rev_share: parseFloat(rev_share) || 0,
                parent_config_id: finalParentIdentId,
                status: 'active'
            });
            if (identErr) return res.status(400).json({ success: false, message: 'Failed to create agent identifier: ' + identErr.message });

            // Send portal invite
            const crypto = await import('crypto');
            const inviteToken = crypto.randomBytes(32).toString('hex');
            const expires = new Date(Date.now() + 72 * 60 * 60 * 1000);
            await supabase.from('persons').update({
                portal_invite_token: inviteToken,
                invite_expires_at: expires.toISOString(),
                portal_password_set: false
            }).eq('id', newPerson.id);

            const inviteUrl = `${process.env.SITE_URL || 'https://portal.mypayprotec.com'}/partner?token=${inviteToken}`;
            await sendEmail(
                newPerson.email,
                "You've been invited to the PayProTec Partner Portal",
                `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;border:1px solid #e2e8f0;border-radius:16px;">
                    <h2 style="color:#001e3c;">Welcome to your Partner Portal</h2>
                    <p style="color:#475569;line-height:1.6;">Hi <strong>${properName}</strong>, you've been invited to access the PayProTec Partner Portal as a sub-partner.</p>
                    <div style="text-align:center;margin:28px 0;">
                        <a href="${inviteUrl}" style="display:inline-block;padding:14px 32px;background:#0d9488;color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">Set Up My Account →</a>
                    </div>
                    <p style="color:#94a3b8;font-size:12px;">This link expires in 72 hours.</p>
                </div>`,
                `Hi ${properName}, you've been invited to the PayProTec Partner Portal. Set up your account: ${inviteUrl}`
            );

            // Log to activity_logs
            try {
                await supabase.from('activity_logs').insert({
                    action: 'Invite Sub-Partner',
                    category: 'partners',
                    details: `${properName} (${email}) invited as sub-partner by person ${myPersonId}`,
                    person_id: myPersonId
                });
            } catch (e) { /* non-critical */ }

            return res.status(200).json({ success: true, person_id: newPerson.id });
        }

        // --- ACTION: UPDATE SUB-PARTNER REV SHARE (partner-portal) ---
        if (action === 'update_sub_partner_rev_share') {
            const myPersonId = await resolvePartnerPersonId();
            if (!myPersonId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { identifier_id, rev_share } = body;
            if (!identifier_id || rev_share === undefined) {
                return res.status(400).json({ success: false, message: 'identifier_id and rev_share are required.' });
            }

            // Security: verify the identifier belongs to a sub-partner of this partner
            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', myPersonId);
            if (!myAgents || !myAgents.length) return res.status(403).json({ success: false, message: 'Access denied.' });
            const myAgentIds = myAgents.map(a => a.id);

            const { data: myIdentifiers } = await supabase.from('agent_identifiers').select('id').in('agent_id', myAgentIds);
            if (!myIdentifiers || !myIdentifiers.length) return res.status(403).json({ success: false, message: 'Access denied.' });
            const myIdentifierIds = myIdentifiers.map(i => i.id);

            // Check the target identifier has parent_config_id in myIdentifierIds
            const { data: targetIdent } = await supabase
                .from('agent_identifiers')
                .select('id, parent_config_id')
                .eq('id', identifier_id)
                .single();
            if (!targetIdent || !myIdentifierIds.includes(targetIdent.parent_config_id)) {
                return res.status(403).json({ success: false, message: 'Access denied: identifier is not a sub-partner of yours.' });
            }

            const { error } = await supabase
                .from('agent_identifiers')
                .update({ rev_share: parseFloat(rev_share) })
                .eq('id', identifier_id);
            if (error) throw error;

            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET SUB-PARTNERS FOR STAFF ---
        if (action === 'get_sub_partners_for_staff') {
            const { person_id: targetPersonId } = body;
            if (!targetPersonId) return res.status(400).json({ success: false, message: 'person_id required.' });

            // Get all agents belonging to the target partner
            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', targetPersonId);
            if (!myAgents || !myAgents.length) return res.status(200).json({ success: true, data: [] });
            const myAgentIds = myAgents.map(a => a.id);

            const { data: myIdentifiers } = await supabase.from('agent_identifiers').select('id, id_string').in('agent_id', myAgentIds);
            if (!myIdentifiers || !myIdentifiers.length) return res.status(200).json({ success: true, data: [] });
            const myIdentifierIds = myIdentifiers.map(i => i.id);
            const parentIdentMap = {}; // parent identifier id → parent id_string
            myIdentifiers.forEach(i => { parentIdentMap[i.id] = i.id_string; });

            const { data: subIdentifiers } = await supabase
                .from('agent_identifiers')
                .select('id, agent_id, id_string, rev_share, parent_config_id')
                .in('parent_config_id', myIdentifierIds);
            if (!subIdentifiers || !subIdentifiers.length) return res.status(200).json({ success: true, data: [] });

            const subAgentIds = [...new Set(subIdentifiers.map(i => i.agent_id))];
            const { data: subAgents } = await supabase.from('agents').select('id, parent_agent_id').in('id', subAgentIds);
            if (!subAgents || !subAgents.length) return res.status(200).json({ success: true, data: [] });
            const subPersonIds = [...new Set(subAgents.filter(a => a.parent_agent_id).map(a => a.parent_agent_id))];

            const { data: subPersons } = await supabase.from('persons').select('id, full_name, email, is_portal_active').in('id', subPersonIds);
            if (!subPersons || !subPersons.length) return res.status(200).json({ success: true, data: [] });

            const agentToPersonMap = {};
            subAgents.forEach(a => { agentToPersonMap[a.id] = a.parent_agent_id; });

            const personIdentMap = {};
            const personParentAgentIds = {}; // sub-person id → Set of parent id_strings they're linked under
            subIdentifiers.forEach(si => {
                const pid = agentToPersonMap[si.agent_id];
                if (!pid) return;
                if (!personIdentMap[pid]) personIdentMap[pid] = [];
                personIdentMap[pid].push({ id_string: si.id_string, rev_share: si.rev_share });
                if (si.parent_config_id && parentIdentMap[si.parent_config_id]) {
                    if (!personParentAgentIds[pid]) personParentAgentIds[pid] = new Set();
                    personParentAgentIds[pid].add(parentIdentMap[si.parent_config_id]);
                }
            });

            const allSubIdStrings = subIdentifiers.map(i => i.id_string);
            let merchantRows = [];
            const CHUNK = 500;
            for (let i = 0; i < allSubIdStrings.length; i += CHUNK) {
                const chunk = allSubIdStrings.slice(i, i + CHUNK);
                const { data: mChunk } = await supabase.from('merchants').select('agent_id, volume_30_day').in('agent_id', chunk);
                if (mChunk) merchantRows = merchantRows.concat(mChunk);
            }

            const idStringToPersonId = {};
            subIdentifiers.forEach(si => {
                const pid = agentToPersonMap[si.agent_id];
                if (pid) idStringToPersonId[si.id_string] = pid;
            });

            const personMerchStats = {};
            merchantRows.forEach(m => {
                const pid = idStringToPersonId[m.agent_id];
                if (!pid) return;
                if (!personMerchStats[pid]) personMerchStats[pid] = { merchant_count: 0, volume_30_day: 0 };
                personMerchStats[pid].merchant_count++;
                personMerchStats[pid].volume_30_day += parseFloat(m.volume_30_day || 0);
            });

            const result = subPersons.map(p => ({
                person_id: p.id,
                full_name: p.full_name,
                email: p.email,
                is_portal_active: p.is_portal_active,
                agent_ids: personIdentMap[p.id] || [],
                parent_agent_ids: personParentAgentIds[p.id] ? [...personParentAgentIds[p.id]] : [],
                merchant_count: personMerchStats[p.id]?.merchant_count || 0,
                volume_30_day: personMerchStats[p.id]?.volume_30_day || 0
            }));

            return res.status(200).json({ success: true, data: result });
        }

        if (action === 'get_new_enrollments_by_partner') {
            const { start_date, end_date } = body;
            const now = new Date();
            const daysToMonday = (now.getDay() + 6) % 7;
            const monday = new Date(now);
            monday.setDate(now.getDate() - daysToMonday);
            monday.setHours(0, 0, 0, 0);
            const from = start_date || monday.toISOString();
            const to = end_date || now.toISOString();

            let newMerchants = [];
            let offset = 0, done = false;
            while (!done) {
                const { data: batch, error } = await supabase.from('merchants')
                    .select('merchant_id, dba_name, enrollment_date, agent_id, account_status')
                    .gte('enrollment_date', from).lte('enrollment_date', to)
                    .order('enrollment_date', { ascending: false })
                    .range(offset, offset + 999);
                if (error || !batch || batch.length === 0) { done = true; }
                else { newMerchants = newMerchants.concat(batch); offset += 1000; if (batch.length < 1000) done = true; }
            }

            if (!newMerchants.length) return res.status(200).json({ success: true, total: 0, by_partner: {}, period: { from, to } });

            const agentIdStrings = [...new Set(newMerchants.map(m => m.agent_id).filter(Boolean))];
            const { data: identRows } = await supabase.from('agent_identifiers')
                .select('id_string, agent_id').in('id_string', agentIdStrings);

            if (!identRows?.length) return res.status(200).json({ success: true, total: newMerchants.length, by_partner: {}, period: { from, to } });

            const idStringToAgentUuid = {};
            identRows.forEach(i => { idStringToAgentUuid[i.id_string] = i.agent_id; });
            const agentUuids = [...new Set(Object.values(idStringToAgentUuid))];

            const { data: agentRows } = await supabase.from('agents')
                .select('id, parent_agent_id').in('id', agentUuids);

            const agentUuidToPersonId = {};
            (agentRows || []).forEach(a => { if (a.parent_agent_id) agentUuidToPersonId[a.id] = a.parent_agent_id; });
            const personIds = [...new Set(Object.values(agentUuidToPersonId))];

            const { data: personRows } = await supabase.from('persons')
                .select('id, full_name').in('id', personIds);
            const personNameMap = {};
            (personRows || []).forEach(p => { personNameMap[p.id] = p.full_name; });

            const byPartner = {};
            newMerchants.forEach(m => {
                const agentUuid = idStringToAgentUuid[m.agent_id];
                if (!agentUuid) return;
                const personId = agentUuidToPersonId[agentUuid];
                if (!personId) return;
                if (!byPartner[personId]) byPartner[personId] = { name: personNameMap[personId] || 'Unknown', count: 0, merchants: [] };
                byPartner[personId].count++;
                byPartner[personId].merchants.push({ merchant_id: m.merchant_id, dba_name: m.dba_name, enrollment_date: m.enrollment_date, account_status: m.account_status });
            });

            return res.status(200).json({ success: true, total: newMerchants.length, by_partner: byPartner, period: { from, to } });
        }

        if (action === 'get_partner_by_agent') {
            const { agent_id: idString } = body;
            if (!idString) return res.status(400).json({ success: false, message: 'agent_id required' });
            const { data: identRow } = await supabase.from('agent_identifiers').select('agent_id, id_string, rev_share').eq('id_string', idString).maybeSingle();
            if (!identRow) return res.status(200).json({ success: true, data: null });
            const { data: agentRow } = await supabase.from('agents').select('id, parent_agent_id, company_id').eq('id', identRow.agent_id).maybeSingle();
            if (!agentRow) return res.status(200).json({ success: true, data: null });
            const [personRes, companyRes] = await Promise.all([
                agentRow.parent_agent_id ? supabase.from('persons').select('id, full_name, email, phone_number, enrolled_at, is_portal_active').eq('id', agentRow.parent_agent_id).maybeSingle() : { data: null },
                agentRow.company_id ? supabase.from('companies').select('id, company_name').eq('id', agentRow.company_id).maybeSingle() : { data: null }
            ]);
            return res.status(200).json({ success: true, data: {
                person_id: personRes.data?.id || null,
                full_name: personRes.data?.full_name || null,
                email: personRes.data?.email || null,
                phone: personRes.data?.phone_number || null,
                enrolled_at: personRes.data?.enrolled_at || null,
                is_portal_active: personRes.data?.is_portal_active || false,
                company_name: companyRes.data?.company_name || null,
                agent_id: idString,
                rev_share: identRow.rev_share || null
            }});
        }

        if (action === 'get_new_partners_this_week') {
            const now = new Date();
            const daysToMonday = (now.getDay() + 6) % 7;
            const monday = new Date(now);
            monday.setDate(now.getDate() - daysToMonday);
            monday.setHours(0, 0, 0, 0);
            const from = monday.toISOString();

            const { data: newPersons, error: personErr } = await supabase
                .from('persons')
                .select('id, full_name, email, enrolled_at')
                .gte('enrolled_at', from)
                .not('enrolled_at', 'is', null)
                .order('enrolled_at', { ascending: false });
            if (personErr) throw personErr;
            if (!newPersons?.length) return res.status(200).json({ success: true, data: [], week_start: from });

            const personIds = newPersons.map(p => p.id);
            const { data: agentRows } = await supabase.from('agents').select('id, parent_agent_id, company_id').in('parent_agent_id', personIds);
            const agentUuids = (agentRows || []).map(a => a.id);
            const { data: identRows } = agentUuids.length
                ? await supabase.from('agent_identifiers').select('agent_id, id_string').in('agent_id', agentUuids)
                : { data: [] };

            const companyIds = [...new Set((agentRows || []).map(a => a.company_id).filter(Boolean))];
            const { data: companyRows } = companyIds.length
                ? await supabase.from('companies').select('id, company_name').in('id', companyIds)
                : { data: [] };
            const companyMap = {};
            (companyRows || []).forEach(c => { companyMap[c.id] = c.company_name; });

            const personAgentMap = {};
            (agentRows || []).forEach(a => {
                if (!personAgentMap[a.parent_agent_id]) personAgentMap[a.parent_agent_id] = { agents: [], company_name: null };
                personAgentMap[a.parent_agent_id].agents.push(a.id);
                if (a.company_id && !personAgentMap[a.parent_agent_id].company_name)
                    personAgentMap[a.parent_agent_id].company_name = companyMap[a.company_id] || null;
            });
            const agentIdentMap = {};
            (identRows || []).forEach(i => {
                if (!agentIdentMap[i.agent_id]) agentIdentMap[i.agent_id] = [];
                agentIdentMap[i.agent_id].push(i.id_string);
            });

            const result = newPersons.map(p => {
                const agentInfo = personAgentMap[p.id] || { agents: [], company_name: null };
                const idStrings = agentInfo.agents.flatMap(aid => agentIdentMap[aid] || []);
                return { person_id: p.id, full_name: p.full_name, email: p.email, enrolled_at: p.enrolled_at, company_name: agentInfo.company_name, agent_ids: idStrings };
            });
            return res.status(200).json({ success: true, data: result, week_start: from });
        }

        if (action === 'get_first_production') {
            // Agent IDs whose ALL-TIME total merchant count equals their this-week count
            // = they had zero merchants before this week → true first production
            const now = new Date();
            const daysToMonday = (now.getDay() + 6) % 7;
            const monday = new Date(now);
            monday.setDate(now.getDate() - daysToMonday);
            monday.setHours(0, 0, 0, 0);
            const { days = 7 } = body;
            const cutoff = days <= 7 ? monday : new Date(now.getTime() - days * 86400000);
            const from = cutoff.toISOString();

            // Step 1: Approved merchants created this period — paginated, no row limit
            let recentMerchants = [], rmOffset = 0, rmDone = false;
            while (!rmDone) {
                const { data: batch } = await supabase
                    .from('merchants')
                    .select('agent_id, dba_name, merchant_id, enrollment_date, created_at, account_status')
                    .gte('created_at', from)
                    .eq('account_status', 'Approved')
                    .order('created_at', { ascending: false })
                    .range(rmOffset, rmOffset + 999);
                if (!batch || batch.length === 0) { rmDone = true; }
                else { recentMerchants = recentMerchants.concat(batch); rmOffset += 1000; if (batch.length < 1000) rmDone = true; }
            }
            if (!recentMerchants.length) return res.status(200).json({ success: true, data: [] });

            const recentAgentIds = [...new Set(recentMerchants.map(m => m.agent_id).filter(Boolean))];

            // This-week count per agent_id
            const thisWeekCount = {};
            recentMerchants.forEach(m => { if (m.agent_id) thisWeekCount[m.agent_id] = (thisWeekCount[m.agent_id] || 0) + 1; });

            // Step 2: ALL-TIME total merchant count per agent_id — paginated, chunked IN clause
            let allTimeRows = [];
            const CHUNK = 500;
            for (let i = 0; i < recentAgentIds.length; i += CHUNK) {
                const chunk = recentAgentIds.slice(i, i + CHUNK);
                let atOffset = 0, atDone = false;
                while (!atDone) {
                    const { data: batch } = await supabase
                        .from('merchants')
                        .select('agent_id')
                        .in('agent_id', chunk)
                        .range(atOffset, atOffset + 999);
                    if (!batch || batch.length === 0) { atDone = true; }
                    else { allTimeRows = allTimeRows.concat(batch); atOffset += 1000; if (batch.length < 1000) atDone = true; }
                }
            }

            const allTimeCount = {};
            (allTimeRows || []).forEach(m => { if (m.agent_id) allTimeCount[m.agent_id] = (allTimeCount[m.agent_id] || 0) + 1; });

            // Step 3: First-timers = agent_ids where all-time count == this-week count (no merchants before)
            const firstTimers = recentAgentIds.filter(aid => allTimeCount[aid] === thisWeekCount[aid]);
            if (!firstTimers.length) return res.status(200).json({ success: true, data: [] });

            // Resolve agent id_string → agent uuid → person
            const { data: identRows } = await supabase.from('agent_identifiers').select('id_string, agent_id').in('id_string', firstTimers);
            const idToAgentUuid = {};
            (identRows || []).forEach(i => { idToAgentUuid[i.id_string] = i.agent_id; });
            const agentUuids = [...new Set(Object.values(idToAgentUuid))];
            const { data: agentRows } = await supabase.from('agents').select('id, parent_agent_id').in('id', agentUuids);
            const agentToPersonId = {};
            (agentRows || []).forEach(a => { if (a.parent_agent_id) agentToPersonId[a.id] = a.parent_agent_id; });
            const personIds = [...new Set(Object.values(agentToPersonId))];
            const { data: personRows } = await supabase.from('persons').select('id, full_name, email, enrolled_at').in('id', personIds);
            const personMap = {};
            (personRows || []).forEach(p => { personMap[p.id] = p; });

            // Group by person — show the specific agent ID that went live
            const byPerson = {};
            firstTimers.forEach(agentIdStr => {
                const agentUuid = idToAgentUuid[agentIdStr];
                if (!agentUuid) return;
                const personId = agentToPersonId[agentUuid];
                if (!personId) return;
                const person = personMap[personId];
                if (!person) return;
                if (!byPerson[personId]) byPerson[personId] = {
                    person_id: personId, full_name: person.full_name, email: person.email,
                    enrolled_at: person.enrolled_at || null,
                    agent_ids: [], merchants: []
                };
                if (!byPerson[personId].agent_ids.includes(agentIdStr))
                    byPerson[personId].agent_ids.push(agentIdStr);
                recentMerchants.filter(m => m.agent_id === agentIdStr)
                    .forEach(m => byPerson[personId].merchants.push(m));
            });

            const result = Object.values(byPerson).sort((a, b) => b.merchants.length - a.merchants.length);
            return res.status(200).json({ success: true, data: result });
        }

        // --- ACTION: GET FULL GHL CONTACT DETAILS ---
        if (action === 'get_ghl_contact') {
            const { hl_contact_id } = body;
            if (!hl_contact_id) return res.status(400).json({ success: false, message: 'hl_contact_id required.' });
            const ghlApiKey      = (await getConfigValue('GHL_API_KEY'))      || process.env.GHL_API_KEY;
            const ghlLocationId  = (await getConfigValue('GHL_LOCATION_ID'))  || process.env.GHL_LOCATION_ID;
            if (!ghlApiKey) return res.status(500).json({ success: false, message: 'GHL not configured.' });
            const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28', 'Accept': 'application/json' };

            // Fetch contact + custom field definitions in parallel
            const [cRes, cfRes] = await Promise.all([
                fetch(`https://services.leadconnectorhq.com/contacts/${hl_contact_id}`, { headers: ghlHeaders }),
                ghlLocationId
                    ? fetch(`https://services.leadconnectorhq.com/locations/${ghlLocationId}/customFields`, { headers: ghlHeaders })
                    : Promise.resolve(null)
            ]);

            if (!cRes.ok) {
                const errText = await cRes.text();
                return res.status(cRes.status).json({ success: false, message: `GHL error ${cRes.status}: ${errText.slice(0, 300)}` });
            }
            const cData = await cRes.json();
            const contact = cData.contact || cData;

            // Build fieldId → friendly name map
            const fieldNameMap = {};
            if (cfRes && cfRes.ok) {
                try {
                    const cfData = await cfRes.json();
                    const defs = cfData.customFields || cfData.custom_fields || [];
                    defs.forEach(f => { if (f.id) fieldNameMap[f.id] = f.name || f.fieldKey || f.id; });
                } catch { /* non-fatal */ }
            }

            // Resolve assignedTo and followers to display names
            const userIdsToResolve = [...new Set([contact.assignedTo, ...(contact.followers || [])].filter(Boolean))];
            const { data: appUsers } = await supabase.from('app_users').select('email, first_name, last_name');
            const appByEmail = {};
            (appUsers || []).forEach(u => { if (u.email) appByEmail[u.email.toLowerCase()] = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email; });

            const userMap = {};
            await Promise.all(userIdsToResolve.map(async uid => {
                try {
                    const uRes = await fetch(`https://services.leadconnectorhq.com/users/${uid}`, { headers: ghlHeaders });
                    if (uRes.ok) {
                        const uData = await uRes.json();
                        const u = uData.user || uData;
                        const email = (u.email || '').toLowerCase();
                        userMap[uid] = { name: appByEmail[email] || u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Unknown', email: u.email || null };
                    } else { userMap[uid] = { name: 'Unknown', email: null }; }
                } catch { userMap[uid] = { name: 'Unknown', email: null }; }
            }));

            return res.status(200).json({
                success: true,
                contact,
                fieldNameMap,
                ghlLocationId: ghlLocationId || null,
                assignedUser: contact.assignedTo ? { uid: contact.assignedTo, ...userMap[contact.assignedTo] } : null,
                followers: (contact.followers || []).map(uid => ({ uid, ...(userMap[uid] || { name: 'Unknown', email: null }) }))
            });
        }

        // --- ACTION: LIST PARTNER DOCUMENTS ---
        // --- ACTION: LIST DOCUMENT NOTES (from GHL contact notes) ---
        if (action === 'list_document_notes') {
            const { hl_contact_id } = body;
            if (!hl_contact_id) return res.status(200).json({ success: true, documents: [] });
            const ghlApiKey = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
            if (!ghlApiKey) return res.status(500).json({ success: false, message: 'GHL not configured.' });
            const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28' };
            const ghlRes = await fetch(`https://services.leadconnectorhq.com/contacts/${hl_contact_id}/notes`, { headers: ghlHeaders });
            if (!ghlRes.ok) return res.status(200).json({ success: true, documents: [] });
            const ghlData = await ghlRes.json();
            const notes = ghlData.notes || [];
            const documents = notes
                .filter(n => (n.body || '').startsWith('[DOC]'))
                .map(n => {
                    const lines = (n.body || '').split('\n');
                    const filename = lines[0].replace('[DOC]', '').trim();
                    const file_url = lines[1]?.trim() || null;
                    return { id: n.id, filename, file_url, date_added: n.dateAdded };
                });
            return res.status(200).json({ success: true, documents });
        }

        // --- ACTION: CREATE DOCUMENT NOTE (GHL) ---
        if (action === 'create_document_note') {
            const { hl_contact_id, filename, file_url } = body;
            if (!hl_contact_id || !filename) return res.status(400).json({ success: false, message: 'hl_contact_id and filename required.' });
            const ghlApiKey = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
            if (!ghlApiKey) return res.status(500).json({ success: false, message: 'GHL not configured.' });
            const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' };
            const noteBody = file_url ? `[DOC] ${filename}\n${file_url}` : `[DOC] ${filename}`;
            const ghlRes = await fetch(`https://services.leadconnectorhq.com/contacts/${hl_contact_id}/notes`, {
                method: 'POST', headers: ghlHeaders,
                body: JSON.stringify({ userId: session.userid, body: noteBody })
            });
            if (!ghlRes.ok) {
                const errText = await ghlRes.text();
                return res.status(ghlRes.status).json({ success: false, message: `GHL error: ${errText.slice(0, 300)}` });
            }
            const ghlData = await ghlRes.json();
            return res.status(200).json({ success: true, note_id: ghlData.note?.id });
        }

        // --- ACTION: DELETE DOCUMENT NOTE (GHL) ---
        if (action === 'delete_document_note') {
            const { hl_contact_id, note_id } = body;
            if (!hl_contact_id || !note_id) return res.status(400).json({ success: false, message: 'hl_contact_id and note_id required.' });
            const ghlApiKey = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
            if (!ghlApiKey) return res.status(500).json({ success: false, message: 'GHL not configured.' });
            const ghlHeaders = { 'Authorization': `Bearer ${ghlApiKey}`, 'Version': '2021-07-28' };
            const ghlRes = await fetch(`https://services.leadconnectorhq.com/contacts/${hl_contact_id}/notes/${note_id}`, {
                method: 'DELETE', headers: ghlHeaders
            });
            if (!ghlRes.ok && ghlRes.status !== 404) {
                const errText = await ghlRes.text();
                return res.status(ghlRes.status).json({ success: false, message: `GHL error: ${errText.slice(0, 300)}` });
            }
            return res.status(200).json({ success: true });
        }

        // --- ACTION: LIST PARTNER HL CONTACT IDs (for Secret Dungeon manager) ---
        if (action === 'list_partner_hl_ids') {
            const { search } = body;
            let query = supabase
                .from('persons')
                .select('id, full_name, email, hl_contact_id')
                .order('full_name');
            if (search && search.trim()) {
                const s = search.trim();
                query = query.or(`full_name.ilike.%${s}%,email.ilike.%${s}%,hl_contact_id.ilike.%${s}%`);
            }
            const { data, error } = await query;
            if (error) return res.status(500).json({ success: false, message: error.message });
            return res.status(200).json({ success: true, partners: data || [] });
        }

        // --- ACTION: UPDATE HL CONTACT ID (for Secret Dungeon manager) ---
        if (action === 'update_hl_contact_id') {
            const { person_id, hl_contact_id: newHlId } = body;
            if (!person_id) return res.status(400).json({ success: false, message: 'person_id required.' });
            const trimmed = (newHlId || '').trim();

            // Check for duplicate if non-empty
            if (trimmed) {
                const { data: existing } = await supabase
                    .from('persons')
                    .select('id, full_name')
                    .eq('hl_contact_id', trimmed)
                    .neq('id', person_id)
                    .maybeSingle();
                if (existing) {
                    return res.status(409).json({
                        success: false,
                        message: `This contact ID is already linked to "${existing.full_name}".`
                    });
                }
            }

            const { error } = await supabase
                .from('persons')
                .update({ hl_contact_id: trimmed || null })
                .eq('id', person_id);
            if (error) return res.status(500).json({ success: false, message: error.message });

            const actor = await resolveActor();
            await supabase.from('activity_logs').insert({
                actor_email: actor.email,
                actor_name: actor.name,
                action: 'HL Contact ID updated',
                entity_type: 'partner',
                entity_id: person_id,
                details: JSON.stringify({ new_hl_contact_id: trimmed || null })
            });

            return res.status(200).json({ success: true });
        }

        // --- ACTION: SEARCH PARTNER FOR MERGE ---
        if (action === 'search_partner_for_merge') {
            const { data: _mergeActor1 } = await supabase.from('app_users').select('role, is_active').eq('userid', session.userid).single();
            if (!_mergeActor1 || _mergeActor1.role !== 'super_admin' || !_mergeActor1.is_active) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const { q } = body;
            if (!q || q.length < 2) return res.status(400).json({ success: false, message: 'Query too short' });
            const { data: persons } = await supabase.from('persons')
                .select('id, full_name, email, phone_number, enrolled_at')
                .or(`full_name.ilike.%${q}%,email.ilike.%${q}%`)
                .order('full_name').limit(10);
            const ids = (persons || []).map(p => p.id);
            if (ids.length === 0) return res.status(200).json({ success: true, data: [] });
            const { data: agentRows } = await supabase.from('agents')
                .select('parent_agent_id, companies:company_id(company_name)')
                .in('parent_agent_id', ids);
            const companyMap = {};
            (agentRows || []).forEach(a => {
                if (!companyMap[a.parent_agent_id]) companyMap[a.parent_agent_id] = [];
                const name = a.companies?.company_name;
                if (name) companyMap[a.parent_agent_id].push(name);
            });
            const result = (persons || []).map(p => ({ ...p, companies: companyMap[p.id] || [] }));
            return res.status(200).json({ success: true, data: result });
        }

        // --- ACTION: GET PARTNER MERGE PREVIEW ---
        if (action === 'get_partner_merge_preview') {
            const { data: _mergeActor2 } = await supabase.from('app_users').select('role, is_active').eq('userid', session.userid).single();
            if (!_mergeActor2 || _mergeActor2.role !== 'super_admin' || !_mergeActor2.is_active) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const { source_id, target_id } = body;
            if (!source_id || !target_id || source_id === target_id)
                return res.status(400).json({ success: false, message: 'Invalid IDs' });
            const { data: srcAgents } = await supabase.from('agents')
                .select('id, company_id, companies:company_id(company_name)')
                .eq('parent_agent_id', source_id);
            const { data: tgtAgents } = await supabase.from('agents')
                .select('id, company_id')
                .eq('parent_agent_id', target_id);
            const tgtCompanyIds = new Set((tgtAgents || []).map(a => a.company_id));
            const conflicts = [];
            const transfers = [];
            for (const a of (srcAgents || [])) {
                const companyName = a.companies?.company_name || 'Unknown';
                if (tgtCompanyIds.has(a.company_id)) {
                    const { count } = await supabase.from('agent_identifiers')
                        .select('id', { count: 'exact', head: true }).eq('agent_id', a.id);
                    conflicts.push({ company: companyName, identifiers: count || 0 });
                } else {
                    transfers.push({ company: companyName });
                }
            }
            const [notesRes, ticketsRes, sessionsRes] = await Promise.all([
                supabase.from('partner_notes').select('id', { count: 'exact', head: true }).eq('person_id', source_id),
                supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('person_id', source_id),
                supabase.from('partner_sessions').select('id', { count: 'exact', head: true }).eq('person_id', source_id),
            ]);
            return res.status(200).json({ success: true, preview: {
                notes: notesRes.count || 0,
                support_tickets: ticketsRes.count || 0,
                sessions_cleared: sessionsRes.count || 0,
                agent_transfers: transfers,
                agent_conflicts: conflicts,
            }});
        }

        // --- ACTION: MERGE PARTNERS ---
        if (action === 'merge_partners') {
            const { data: _mergeActor3 } = await supabase.from('app_users').select('role, is_active').eq('userid', session.userid).single();
            if (!_mergeActor3 || _mergeActor3.role !== 'super_admin' || !_mergeActor3.is_active) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const { source_id, target_id } = body;
            if (!source_id || !target_id || source_id === target_id)
                return res.status(400).json({ success: false, message: 'Invalid IDs' });
            const [{ data: srcPerson }, { data: tgtPerson }] = await Promise.all([
                supabase.from('persons').select('full_name, email').eq('id', source_id).single(),
                supabase.from('persons').select('full_name, email').eq('id', target_id).single(),
            ]);
            // Handle agents — merge conflicts, transfer clean ones
            const { data: srcAgents } = await supabase.from('agents').select('id, company_id').eq('parent_agent_id', source_id);
            const { data: tgtAgents } = await supabase.from('agents').select('id, company_id').eq('parent_agent_id', target_id);
            const tgtByCompany = Object.fromEntries((tgtAgents || []).map(a => [a.company_id, a.id]));
            for (const srcAgent of (srcAgents || [])) {
                if (tgtByCompany[srcAgent.company_id]) {
                    await supabase.from('agent_identifiers').update({ agent_id: tgtByCompany[srcAgent.company_id] }).eq('agent_id', srcAgent.id);
                    await supabase.from('agents').delete().eq('id', srcAgent.id);
                } else {
                    await supabase.from('agents').update({ parent_agent_id: target_id, agent_name: tgtPerson?.full_name || '' }).eq('id', srcAgent.id);
                }
            }
            // Transfer related records
            await supabase.from('partner_notes').update({ person_id: target_id }).eq('person_id', source_id);
            await supabase.from('support_tickets').update({ person_id: target_id }).eq('person_id', source_id);
            await supabase.from('partner_email_connections').update({ person_id: target_id }).eq('person_id', source_id);
            // Clear source portal sessions
            await supabase.from('partner_sessions').delete().eq('person_id', source_id);
            // Add system note to target
            await supabase.from('partner_notes').insert({
                person_id: target_id,
                title: 'System: Partner Merge',
                body: `Contact merged from: ${srcPerson?.full_name || source_id} (${srcPerson?.email || ''}).\nPerformed by: ${session.userid}`,
                note_type: 'general',
                source: 'app',
                created_at: new Date().toISOString(),
            });
            // Delete source
            await supabase.from('persons').delete().eq('id', source_id);
            // Activity log (best-effort — don't fail the merge if this errors)
            try {
                await supabase.from('activity_logs').insert({
                    actor_email: session.email || session.userid,
                    actor_name: session.userid,
                    action: 'partner_merge',
                    entity_type: 'partner',
                    entity_id: target_id,
                    details: JSON.stringify({ merged_from: source_id, src_name: srcPerson?.full_name, tgt_name: tgtPerson?.full_name }),
                });
            } catch (e) { /* non-critical */ }
            return res.status(200).json({ success: true, message: `"${srcPerson?.full_name}" merged into "${tgtPerson?.full_name}" successfully.` });
        }

        // --- ACTION: GET SUPPORT EMAILS ---
        if (action === 'get_support_emails') {
            const { data: _actor } = await supabase.from('app_users').select('role, is_active').eq('userid', session.userid).single();
            if (!_actor || _actor.role !== 'super_admin' || !_actor.is_active) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const raw = await getConfigValue('SUPPORT_EMAILS');
            let emails = [];
            if (raw) {
                try { emails = JSON.parse(raw); } catch { emails = raw.split(',').map(e => e.trim()).filter(Boolean); }
            }
            return res.status(200).json({ success: true, emails });
        }

        // --- ACTION: SET SUPPORT EMAILS ---
        if (action === 'set_support_emails') {
            const { data: _actor } = await supabase.from('app_users').select('role, is_active').eq('userid', session.userid).single();
            if (!_actor || _actor.role !== 'super_admin' || !_actor.is_active) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const { emails } = body;
            if (!Array.isArray(emails)) return res.status(400).json({ success: false, message: 'emails must be an array' });
            const cleaned = emails.map(e => e.trim()).filter(e => e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

            const { createCipheriv, createHash, randomBytes } = await import('crypto');
            const keyRaw = createHash('sha256').update(process.env.SUPABASE_SERVICE_ROLE_KEY).digest();
            const iv = randomBytes(16);
            const cipher = createCipheriv('aes-256-gcm', keyRaw, iv);
            const plaintext = JSON.stringify(cleaned);
            const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
            const auth_tag = cipher.getAuthTag();

            const { error } = await supabase.from('app_config').upsert({
                key: 'SUPPORT_EMAILS',
                encrypted_value: encrypted.toString('hex'),
                iv: iv.toString('hex'),
                auth_tag: auth_tag.toString('hex'),
                updated_at: new Date().toISOString(),
                updated_by: session.userid,
            }, { onConflict: 'key' });
            if (error) return res.status(500).json({ success: false, message: error.message });
            return res.status(200).json({ success: true, count: cleaned.length });
        }

        // --- ACTION: REPORT MISSING PARTNER ---
        if (action === 'report_missing_partner') {
            const { partner_name, partner_id, partner_email, notes } = body;
            if (!partner_name?.trim()) return res.status(400).json({ success: false, message: 'Partner name is required.' });

            // Load support email list
            const raw = await getConfigValue('SUPPORT_EMAILS');
            let supportEmails = [];
            if (raw) {
                try { supportEmails = JSON.parse(raw); } catch { supportEmails = raw.split(',').map(e => e.trim()).filter(Boolean); }
            }
            if (!supportEmails.length) return res.status(200).json({ success: true, message: 'Report noted (no support emails configured yet).' });

            const actor = await resolveActor();
            const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });

            const htmlBody = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:10px;">
  <div style="background:#f97316;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;font-size:18px;">⚠️ Missing Partner Report</h2>
    <p style="margin:4px 0 0;font-size:13px;opacity:0.9;">A staff member couldn't find a partner in the system</p>
  </div>
  <div style="background:white;padding:20px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;">
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:140px;"><strong>Partner Name:</strong></td><td style="padding:8px 0;font-size:13px;">${partner_name}</td></tr>
      ${partner_id ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;"><strong>Known Partner ID:</strong></td><td style="padding:8px 0;font-size:13px;font-family:monospace;">${partner_id}</td></tr>` : ''}
      ${partner_email ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;"><strong>Partner Email:</strong></td><td style="padding:8px 0;font-size:13px;">${partner_email}</td></tr>` : ''}
      <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;"><strong>Reported By:</strong></td><td style="padding:8px 0;font-size:13px;">${actor.name} (${actor.email})</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;"><strong>Date/Time:</strong></td><td style="padding:8px 0;font-size:13px;">${now} ET</td></tr>
    </table>
    ${notes ? `<div style="margin-top:14px;padding:12px;background:#fff7ed;border-radius:8px;border-left:3px solid #f97316;"><p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#c2410c;text-transform:uppercase;letter-spacing:0.5px;">Notes</p><p style="margin:0;font-size:13px;color:#374151;line-height:1.6;">${notes.replace(/\n/g, '<br>')}</p></div>` : ''}
    <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">Sent automatically from the Merchant Management Console — Partners Dashboard.</p>
  </div>
</div>`;
            const textBody = `Missing Partner Report\n\nPartner Name: ${partner_name}\n${partner_id ? `Known Partner ID: ${partner_id}\n` : ''}${partner_email ? `Partner Email: ${partner_email}\n` : ''}Reported By: ${actor.name} (${actor.email})\nDate/Time: ${now} ET${notes ? `\n\nNotes:\n${notes}` : ''}`;

            for (const toEmail of supportEmails) {
                await sendEmail(toEmail, `⚠️ Missing Partner Report: ${partner_name}`, htmlBody, textBody);
            }
            return res.status(200).json({ success: true, message: `Report sent to ${supportEmails.length} support recipient(s).` });
        }

        if (action === 'get_partners_no_ids') {
            // Fetch all persons with their agent chain, filter to those with no identifiers
            const { data: persons, error } = await supabase
                .from('persons')
                .select('id, full_name, email, phone_number, enrolled_at, agents(id, agent_identifiers(id))')
                .order('full_name', { ascending: true });
            if (error) throw error;

            const noIds = (persons || []).filter(p => {
                const totalIds = (p.agents || []).reduce((sum, a) => sum + (a.agent_identifiers?.length || 0), 0);
                return totalIds === 0;
            }).map(p => ({
                id:           p.id,
                full_name:    p.full_name || '—',
                email:        p.email || '',
                phone_number: p.phone_number || '',
                enrolled_at:  p.enrolled_at,
                has_agents:   (p.agents || []).length > 0,
            }));

            return res.status(200).json({ success: true, partners: noIds });
        }

        if (action === 'lookup_identifier') {
            const { id_string } = body;
            if (!id_string?.trim()) return res.status(400).json({ success: false, message: 'id_string is required.' });

            const { data: existing } = await supabase
                .from('agent_identifiers')
                .select('id, agent_id, agents(id, parent_agent_id, persons:parent_agent_id(id, full_name, email))')
                .eq('id_string', id_string.trim())
                .maybeSingle();

            if (!existing) return res.status(200).json({ success: true, status: 'not_found' });

            const person = existing.agents?.persons;
            if (person?.id) {
                return res.status(200).json({
                    success: true, status: 'assigned',
                    assigned_to: person.full_name || person.email || 'Unknown partner',
                });
            }
            // Exists in DB but no real person linked — can be reassigned
            return res.status(200).json({ success: true, status: 'unassigned', identifier_id: existing.id });
        }

        if (action === 'assign_identifier_to_partner') {
            const { person_id, id_string, rev_share, prime49: isPrime } = body;
            if (!person_id)         return res.status(400).json({ success: false, message: 'person_id is required.' });
            if (!id_string?.trim()) return res.status(400).json({ success: false, message: 'ID string is required.' });

            // Verify person exists
            const { data: person, error: pErr } = await supabase
                .from('persons').select('id, full_name').eq('id', person_id).single();
            if (pErr || !person) return res.status(404).json({ success: false, message: 'Partner not found.' });

            // Check what state the ID is in
            const { data: existing } = await supabase
                .from('agent_identifiers')
                .select('id, agent_id, agents(id, parent_agent_id, persons:parent_agent_id(id))')
                .eq('id_string', id_string.trim())
                .maybeSingle();

            const revNum = parseFloat(String(rev_share || '0').replace(/%/g, '')) || 0;

            if (existing) {
                // Already assigned to a real person — hands off
                if (existing.agents?.persons?.id) {
                    return res.status(409).json({ success: false, message: `ID "${id_string.trim()}" is already assigned to another partner.` });
                }
                // Exists but unassigned — find/create agent for target person, then reassign
                let { data: agent } = await supabase
                    .from('agents').select('id').eq('parent_agent_id', person_id).maybeSingle();
                if (!agent) {
                    const { data: newAgent, error: aErr } = await supabase
                        .from('agents').insert({ parent_agent_id: person_id, agent_name: person.full_name || '' })
                        .select('id').single();
                    if (aErr) throw aErr;
                    agent = newAgent;
                }
                const { error: uErr } = await supabase.from('agent_identifiers').update({
                    agent_id:  agent.id,
                    rev_share: revNum + '%',
                    prime49:   !!isPrime,
                    status:    'active',
                }).eq('id', existing.id);
                if (uErr) throw uErr;

                const actorRes = await supabase.from('app_users').select('email').eq('userid', session.userid).maybeSingle();
                const actorEmail = actorRes.data?.email || session.userid;
                supabase.from('activity_logs').insert({
                    email: actorEmail,
                    action: `Agent ID reassigned: "${id_string.trim()}" (was unassigned) → ${person.full_name} (rev share ${revNum}%, prime49: ${!!isPrime})`,
                    status: 'success', category: 'partners', target_id: person_id,
                    target_type: 'partner', severity: 'info',
                    new_value: { id_string: id_string.trim(), rev_share: revNum + '%', prime49: !!isPrime, person_id, assigned_by: actorEmail, action: 'reassigned' }
                }).then(() => {}).catch(() => {});

                return res.status(200).json({ success: true, action_taken: 'reassigned' });
            }

            // Not in DB — create fresh and assign
            let { data: agent } = await supabase
                .from('agents').select('id').eq('parent_agent_id', person_id).maybeSingle();
            if (!agent) {
                const { data: newAgent, error: aErr } = await supabase
                    .from('agents').insert({ parent_agent_id: person_id, agent_name: person.full_name || '' })
                    .select('id').single();
                if (aErr) throw aErr;
                agent = newAgent;
            }
            const { error: iErr } = await supabase.from('agent_identifiers').insert({
                agent_id:  agent.id,
                id_string: id_string.trim(),
                rev_share: revNum + '%',
                prime49:   !!isPrime,
                status:    'active',
            });
            if (iErr) throw iErr;

            const actorRes = await supabase.from('app_users').select('email').eq('userid', session.userid).maybeSingle();
            const actorEmail = actorRes.data?.email || session.userid;
            supabase.from('activity_logs').insert({
                email: actorEmail,
                action: `Agent ID assigned (new): "${id_string.trim()}" → ${person.full_name} (rev share ${revNum}%, prime49: ${!!isPrime})`,
                status: 'success', category: 'partners', target_id: person_id,
                target_type: 'partner', severity: 'info',
                new_value: { id_string: id_string.trim(), rev_share: revNum + '%', prime49: !!isPrime, person_id, assigned_by: actorEmail, action: 'created' }
            }).then(() => {}).catch(() => {});

            return res.status(200).json({ success: true, action_taken: 'created' });
        }

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
