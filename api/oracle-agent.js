import { GoogleGenerativeAI } from "@google/generative-ai";
import { validateSession, sessionErrorResponse } from './_validate.js';
import { createClient } from '@supabase/supabase-js';
import { loadActor, isAdminRole } from './_access.js';
import { issueCertificate } from './certificates.js';
import { notifyPartner } from './_notify.js';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ answer: "Method not allowed." });

    const { query, userId, userName, lastResponse } = req.body;
    if (!query && !(req.body.execute_action && req.body.execute_action.name)) return res.status(400).json({ answer: "No query provided." });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ answer: "GEMINI_API_KEY is not configured." });
    }

    // ── OPERATOR MODE (writes) ────────────────────────────────────────────────
    // Jarvis can PREPARE actions; the user must confirm in the UI before they run.
    // Gated by the app_settings flag `jarvis_operator_enabled` and per-action access.
    const actor = await loadActor(session.userid);
    let opEnabled = false;
    try {
        const { data: fl } = await supabase.from('app_settings').select('value').eq('key', 'jarvis_operator_enabled').maybeSingle();
        opEnabled = String(fl?.value) === 'true';
    } catch (e) { opEnabled = false; }

    let pendingAction = null; // set by an action tool during the agentic loop

    const ACTION_SPECS = {
        assign_prospect_rep: {
            access: (a) => !!a && a.is_active !== false && (isAdminRole(a) || a.access_prospects === true || a.access_lead_portal === true),
            describe: async (args) => {
                let rep = args.rep_userid, lead = args.lead_id;
                try { const { data: u } = await supabase.from('app_users').select('first_name,last_name,email').eq('userid', args.rep_userid).maybeSingle(); if (u) rep = (`${u.first_name || ''} ${u.last_name || ''}`.trim()) || u.email; } catch (e) {}
                try { const { data: l } = await supabase.from('leads').select('full_name,email').eq('id', args.lead_id).maybeSingle(); if (l) lead = l.full_name || l.email; } catch (e) {}
                return `Assign rep ${rep} to prospect ${lead}`;
            },
            run: async (args) => {
                if (!args.lead_id || !args.rep_userid) return { ok: false, message: 'lead_id and rep_userid are required.' };
                const { error } = await supabase.from('leads').update({ assigned_rep: args.rep_userid }).eq('id', args.lead_id);
                return error ? { ok: false, message: error.message } : { ok: true, message: 'Rep assigned to the prospect.' };
            }
        },
        award_certificate: {
            access: (a) => !!a && a.is_active !== false && String(a.role || '') === 'super_admin',
            describe: async (args) => {
                let who = args.person_id;
                try { const { data: p } = await supabase.from('persons').select('full_name').eq('id', args.person_id).maybeSingle(); if (p) who = p.full_name; } catch (e) {}
                return `Award certificate "${args.type_id}" to ${who}`;
            },
            run: async (args) => {
                if (!args.person_id || !args.type_id) return { ok: false, message: 'person_id and type_id are required.' };
                const r = await issueCertificate(supabase, { personId: args.person_id, typeId: args.type_id, source: 'awarded' });
                if (!r.ok) return { ok: false, message: r.error || 'Could not award certificate.' };
                return { ok: true, message: r.created ? 'Certificate awarded.' : 'Partner already held that certificate.' };
            }
        },
        update_ticket_status: {
            access: (a) => !!a && a.is_active !== false,
            describe: async (args) => {
                let tn = args.ticket_id;
                try { const { data: t } = await supabase.from('support_tickets').select('ticket_number').eq('id', args.ticket_id).maybeSingle(); if (t) tn = t.ticket_number; } catch (e) {}
                return `Set ticket ${tn} status to "${args.status}"`;
            },
            run: async (args) => {
                const VALID = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];
                if (!args.ticket_id || !args.status) return { ok: false, message: 'ticket_id and status are required.' };
                const status = String(args.status).toLowerCase().replace(/\s+/g, '_');
                if (VALID.indexOf(status) < 0) return { ok: false, message: 'Invalid status. Use one of: ' + VALID.join(', ') };
                const { data: t } = await supabase.from('support_tickets').select('person_id, ticket_number, subject').eq('id', args.ticket_id).maybeSingle();
                if (!t) return { ok: false, message: 'Ticket not found.' };
                const { error } = await supabase.from('support_tickets').update({ status, updated_at: new Date().toISOString() }).eq('id', args.ticket_id);
                if (error) return { ok: false, message: error.message };
                if (t.person_id) {
                    try { await supabase.rpc('increment_partner_unread', { tid: parseInt(args.ticket_id) }); } catch (e) {}
                    await notifyPartner(supabase, { personId: t.person_id, type: 'ticket_update', title: `Ticket ${t.ticket_number} — ${status.replace(/_/g, ' ')}`, body: t.subject || '', link: '/partner/tickets', actorName: 'PayProTec Staff' });
                }
                return { ok: true, message: `Ticket ${t.ticket_number} set to ${status.replace(/_/g, ' ')}.` };
            }
        }
    };

    // ── EXECUTE path: the UI calls this after the user clicks Confirm ──────────
    if (req.body.execute_action && req.body.execute_action.name) {
        const { name, args } = req.body.execute_action;
        const spec = ACTION_SPECS[name];
        if (!spec) return res.status(200).json({ answer: 'Unknown action.', executed: false });
        if (!opEnabled) return res.status(200).json({ answer: 'Operator mode is off. Enable "Jarvis Operator" in Secret Dungeon → Feature Flags.', executed: false });
        if (!spec.access(actor)) return res.status(200).json({ answer: 'You do not have permission for that action.', executed: false });
        const r = await spec.run(args || {});
        try {
            await supabase.from('activity_logs').insert({
                email: actor?.email || session.userid, action: `Jarvis operator: ${name} — ${r.ok ? 'done' : 'failed'}`,
                status: r.ok ? 'success' : 'error', category: 'admin', target_type: 'jarvis_action', target_id: name,
                severity: r.ok ? 'info' : 'warning', new_value: { args, message: r.message }
            });
        } catch (e) {}
        return res.status(200).json({ answer: (r.ok ? '✅ ' : '⚠️ ') + r.message, executed: !!r.ok });
    }

    // ── TOOL DEFINITIONS ──────────────────────────────────────────────────────
    const functionDeclarations = [

        // ── MERCHANTS ──────────────────────────────────────────────────────────
        {
            name: 'get_merchant_overview',
            description: 'Get a high-level merchant health summary: total active, suspended, at-risk count, average monthly volume, and top performers.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_merchants',
            description: 'Search merchants by business name (DBA) or merchant ID (MID). Returns status, volume, agent.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Name or MID to search for' },
                    limit: { type: 'number', description: 'Max results, default 10' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_merchant_detail',
            description: 'Get full profile for a specific merchant by MID string: status, volume trend, agent, open returns, active deployments.',
            parameters: {
                type: 'object',
                properties: {
                    merchant_id: { type: 'string', description: 'The merchant MID string' }
                },
                required: ['merchant_id']
            }
        },
        {
            name: 'get_at_risk_merchants',
            description: 'Get merchants whose 30-day processing volume has dropped 15%+ below their 90-day monthly baseline. Sorted by largest drop first.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max results, default 20' },
                    min_drop_pct: { type: 'number', description: 'Minimum drop % to include, default 15' }
                },
                required: []
            }
        },
        {
            name: 'get_merchants_by_status',
            description: 'Get merchants filtered by account status (Approved, Suspended, Terminated, Pending, PCI Non-Compliant, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'Account status value' },
                    limit: { type: 'number', description: 'Max results, default 20' }
                },
                required: ['status']
            }
        },

        // ── PARTNERS ──────────────────────────────────────────────────────────
        {
            name: 'get_partner_overview',
            description: 'Get a summary of the partner network: total partners, how many have portal access, top partners by volume.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_partners',
            description: 'Search for partners (agents/reps) by name. Returns their merchant count, total volume, and portal status.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Partner name to search' },
                    limit: { type: 'number', description: 'Max results, default 10' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_partner_detail',
            description: 'Get detailed portfolio for a specific partner by their person_id: their merchants, volumes, at-risk merchants.',
            parameters: {
                type: 'object',
                properties: {
                    person_id: { type: 'string', description: 'The partner person UUID' }
                },
                required: ['person_id']
            }
        },
        {
            name: 'get_partners_without_portal',
            description: 'Get partners who have NOT yet been given portal access (is_portal_active is false).',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max results, default 20' }
                },
                required: []
            }
        },

        // ── DEPLOYMENTS ────────────────────────────────────────────────────────
        {
            name: 'get_deployment_overview',
            description: 'Get deployment pipeline summary: count by status (Pending, In Progress, Delivered, Cancelled), recent activity.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'get_deployments',
            description: 'Get deployments filtered by status. Status options: Pending, In Progress, Delivered, Cancelled.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'Deployment status filter, or omit for all recent' },
                    limit: { type: 'number', description: 'Max results, default 15' }
                },
                required: []
            }
        },

        // ── INVENTORY ──────────────────────────────────────────────────────────
        {
            name: 'get_inventory_overview',
            description: 'Get inventory health: total equipment count, stocked units, deployed units, units in repair, decommissioned count.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_inventory',
            description: 'Search inventory by serial number or terminal/device type.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Serial number or device type to search' },
                    limit: { type: 'number', description: 'Max results, default 15' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_inventory_by_location',
            description: 'Get equipment at a specific location. Locations: Warsaw Office, Warsaw Repairs, Merchant Site, In Transit.',
            parameters: {
                type: 'object',
                properties: {
                    location: { type: 'string', description: 'Location name' },
                    limit: { type: 'number', description: 'Max results, default 20' }
                },
                required: ['location']
            }
        },

        // ── RETURNS ────────────────────────────────────────────────────────────
        {
            name: 'get_returns_overview',
            description: 'Get returns summary: open count, pending count, defective rate, recent return activity.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'get_returns',
            description: 'Get return requests filtered by status (Open, Pending, Completed, Cancelled).',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'Return status, or omit for open/pending' },
                    limit: { type: 'number', description: 'Max results, default 15' }
                },
                required: []
            }
        },

        // ── OPERATOR: read helpers (to resolve ids before proposing an action) ──
        {
            name: 'search_prospects',
            description: 'Search prospects/leads by name or email. Returns lead id, name, email, status, and assigned rep. Use to get the lead id before assigning a rep.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'Name or email' } }, required: ['query'] }
        },
        {
            name: 'list_reps',
            description: 'List active staff users (reps) with their userid and name. Use to resolve the rep_userid before assigning a rep to a prospect.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'find_partner_person',
            description: 'Find a partner person by name or email. Returns person_id, full_name, email. Use to get the person_id before awarding a certificate.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'Name or email' } }, required: ['query'] }
        },
        {
            name: 'list_certificate_designs',
            description: 'List available certificate designs. Returns id (type_id), name, category. Use to get the type_id before awarding a certificate.',
            parameters: { type: 'object', properties: {}, required: [] }
        },

        // ── OPERATOR: actions (prepared, then user must confirm in the UI) ──────
        {
            name: 'assign_prospect_rep',
            description: 'Prepare to assign a staff rep to a prospect/lead. Requires lead_id (from search_prospects) and rep_userid (from list_reps). This is NOT executed immediately — it is proposed for the user to confirm.',
            parameters: { type: 'object', properties: { lead_id: { type: 'string' }, rep_userid: { type: 'string' } }, required: ['lead_id', 'rep_userid'] }
        },
        {
            name: 'award_certificate',
            description: 'Prepare to award a certificate to a partner. Requires person_id (from find_partner_person) and type_id (from list_certificate_designs). Proposed for user confirmation, not executed immediately.',
            parameters: { type: 'object', properties: { person_id: { type: 'string' }, type_id: { type: 'string' } }, required: ['person_id', 'type_id'] }
        },
        {
            name: 'update_ticket_status',
            description: 'Prepare to change a support ticket status. Requires ticket_id and status (open, in_progress, waiting, resolved, closed). Proposed for user confirmation, not executed immediately.',
            parameters: { type: 'object', properties: { ticket_id: { type: 'string' }, status: { type: 'string' } }, required: ['ticket_id', 'status'] }
        }
    ];

    // ── TOOL EXECUTOR ─────────────────────────────────────────────────────────
    async function executeTool(name, args) {
        try {
            switch (name) {

                // ── MERCHANTS ────────────────────────────────────────────────
                case 'get_merchant_overview': {
                    const [
                        { count: approved },
                        { count: suspended },
                        { count: terminated },
                        { count: pending },
                        { count: pciNonCompliant }
                    ] = await Promise.all([
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Approved'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Suspended'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Terminated'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Pending'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'PCI Non-Compliant')
                    ]);
                    // Top 5 by 30-day volume
                    const { data: topMerchants } = await supabase.from('merchants')
                        .select('dba_name, merchant_id, volume_30_day, agent_name')
                        .eq('account_status', 'Approved')
                        .order('volume_30_day', { ascending: false })
                        .limit(5);
                    // At-risk count
                    const { data: allActive } = await supabase.from('merchants')
                        .select('volume_30_day, volume_90_day')
                        .eq('account_status', 'Approved')
                        .gt('volume_90_day', 0);
                    const atRiskCount = (allActive || []).filter(m => {
                        const baseline = parseFloat(m.volume_90_day) / 3;
                        return baseline > 0 && (1 - parseFloat(m.volume_30_day) / baseline) >= 0.15;
                    }).length;
                    return { approved, suspended, terminated, pending, pci_non_compliant: pciNonCompliant, at_risk_count: atRiskCount, top_merchants_by_volume: topMerchants || [] };
                }

                case 'search_merchants': {
                    const limit = args.limit || 10;
                    const isNumeric = /^\d+$/.test(args.query);
                    let q = supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_name, merchant_state, last_batch_date')
                        .limit(limit);
                    if (isNumeric) q = q.ilike('merchant_id', `%${args.query}%`);
                    else q = q.ilike('dba_name', `%${args.query}%`);
                    const { data } = await q;
                    return { merchants: data || [], count: (data || []).length };
                }

                case 'get_merchant_detail': {
                    const { data: m } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_name, agent_id, merchant_phone, merchant_state, merchant_email, enrollment_date, last_batch_date')
                        .eq('merchant_id', args.merchant_id).single();
                    if (!m) return { error: 'Merchant not found' };
                    const baseline = m.volume_90_day ? parseFloat(m.volume_90_day) / 3 : 0;
                    const dropPct = baseline > 0 ? Math.round((1 - parseFloat(m.volume_30_day) / baseline) * 100) : 0;
                    const [{ data: deployments }, { data: returns_ }] = await Promise.all([
                        supabase.from('deployments').select('deployment_id, status, target_deployment_date, equipments:equipment_id(terminal_type, serial_number)').eq('merchant_id', m.merchant_id).order('target_deployment_date', { ascending: false }).limit(5),
                        supabase.from('returns').select('return_id, status, return_reason, created_at').eq('merchant_id', m.merchant_id).limit(5)
                    ]);
                    return { ...m, volume_baseline_monthly: Math.round(baseline), volume_drop_pct: dropPct, recent_deployments: deployments || [], recent_returns: returns_ || [] };
                }

                case 'get_at_risk_merchants': {
                    const limit = args.limit || 20;
                    const minDrop = args.min_drop_pct || 15;
                    const { data } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, volume_30_day, volume_90_day, agent_name, account_status, merchant_state')
                        .eq('account_status', 'Approved').gt('volume_90_day', 0).limit(500);
                    const atRisk = (data || [])
                        .map(m => {
                            const baseline = parseFloat(m.volume_90_day) / 3;
                            if (!baseline) return null;
                            const drop = Math.round((1 - parseFloat(m.volume_30_day) / baseline) * 100);
                            if (drop < minDrop) return null;
                            return { ...m, drop_pct: drop, baseline_monthly: Math.round(baseline) };
                        })
                        .filter(Boolean)
                        .sort((a, b) => b.drop_pct - a.drop_pct)
                        .slice(0, limit);
                    return { at_risk: atRisk, count: atRisk.length };
                }

                case 'get_merchants_by_status': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, agent_name, merchant_state, enrollment_date')
                        .eq('account_status', args.status)
                        .order('dba_name').limit(limit);
                    return { merchants: data || [], count: (data || []).length, status: args.status };
                }

                // ── PARTNERS ──────────────────────────────────────────────────
                case 'get_partner_overview': {
                    const [
                        { count: totalPartners },
                        { count: portalActive },
                        { count: portalSetup }
                    ] = await Promise.all([
                        supabase.from('persons').select('*', { count: 'exact', head: true }),
                        supabase.from('persons').select('*', { count: 'exact', head: true }).eq('is_portal_active', true),
                        supabase.from('persons').select('*', { count: 'exact', head: true }).eq('portal_password_set', true)
                    ]);
                    // Top partners by merchant volume
                    const { data: stats } = await supabase.from('agent_stats')
                        .select('agent_id, merchant_count, total_volume_sum')
                        .order('total_volume_sum', { ascending: false }).limit(5);
                    return { total_partners: totalPartners, portal_invited: portalActive, portal_fully_setup: portalSetup, top_partners_by_volume: stats || [] };
                }

                case 'search_partners': {
                    const limit = args.limit || 10;
                    const { data: persons } = await supabase.from('persons')
                        .select('id, full_name, email, is_portal_active, portal_password_set, enrolled_at')
                        .ilike('full_name', `%${args.query}%`).limit(limit);
                    if (!persons?.length) return { partners: [], count: 0 };
                    const personIds = persons.map(p => p.id);
                    const { data: agents } = await supabase.from('agents').select('id, parent_agent_id').in('parent_agent_id', personIds);
                    const agentIds = (agents || []).map(a => a.id);
                    const { data: stats } = agentIds.length
                        ? await supabase.from('agent_stats').select('agent_id, merchant_count, total_volume_sum').in('agent_id', agentIds)
                        : { data: [] };
                    const partners = persons.map(p => {
                        const myAgentIds = (agents || []).filter(a => a.parent_agent_id === p.id).map(a => a.id);
                        const myStats = (stats || []).filter(s => myAgentIds.includes(s.agent_id));
                        const totalVolume = myStats.reduce((sum, s) => sum + (parseFloat(s.total_volume_sum) || 0), 0);
                        const merchantCount = myStats.reduce((sum, s) => sum + (s.merchant_count || 0), 0);
                        return { ...p, merchant_count: merchantCount, total_volume: Math.round(totalVolume) };
                    });
                    return { partners, count: partners.length };
                }

                case 'get_partner_detail': {
                    const { data: person } = await supabase.from('persons')
                        .select('id, full_name, email, is_portal_active, portal_password_set, enrolled_at')
                        .eq('id', args.person_id).single();
                    if (!person) return { error: 'Partner not found' };
                    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', args.person_id);
                    if (!agents?.length) return { ...person, merchants: [], at_risk: [] };
                    const agentIds = agents.map(a => a.id);
                    const { data: identifiers } = await supabase.from('agent_identifiers').select('id_string').in('agent_id', agentIds);
                    const agentIdStrings = (identifiers || []).map(i => i.id_string);
                    if (!agentIdStrings.length) return { ...person, merchants: [], at_risk: [] };
                    const { data: merchants } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day')
                        .in('agent_id', agentIdStrings).limit(50);
                    const atRisk = (merchants || []).filter(m => {
                        const baseline = parseFloat(m.volume_90_day) / 3;
                        return baseline > 0 && (1 - parseFloat(m.volume_30_day) / baseline) >= 0.15;
                    }).map(m => ({ dba_name: m.dba_name, merchant_id: m.merchant_id, drop_pct: Math.round((1 - parseFloat(m.volume_30_day) / (parseFloat(m.volume_90_day) / 3)) * 100) }));
                    return { ...person, total_merchants: (merchants || []).length, merchants: (merchants || []).slice(0, 10), at_risk_merchants: atRisk };
                }

                case 'get_partners_without_portal': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('persons')
                        .select('id, full_name, email, enrolled_at')
                        .eq('is_portal_active', false)
                        .order('enrolled_at', { ascending: false })
                        .limit(limit);
                    return { partners: data || [], count: (data || []).length };
                }

                // ── DEPLOYMENTS ────────────────────────────────────────────────
                case 'get_deployment_overview': {
                    const statuses = ['Pending', 'In Progress', 'Delivered', 'Cancelled'];
                    const counts = await Promise.all(statuses.map(s =>
                        supabase.from('deployments').select('*', { count: 'exact', head: true }).eq('status', s)
                    ));
                    const result = {};
                    statuses.forEach((s, i) => { result[s.toLowerCase().replace(' ', '_')] = counts[i].count || 0; });
                    // Overdue (pending past target date)
                    const { count: overdue } = await supabase.from('deployments')
                        .select('*', { count: 'exact', head: true })
                        .eq('status', 'Pending')
                        .lt('target_deployment_date', new Date().toISOString());
                    result.overdue_pending = overdue || 0;
                    return result;
                }

                case 'get_deployments': {
                    const limit = args.limit || 15;
                    let q = supabase.from('deployments')
                        .select('deployment_id, status, target_deployment_date, purchase_type, merchants:merchant_id(dba_name, merchant_id), equipments:equipment_id(terminal_type, serial_number)')
                        .order('target_deployment_date', { ascending: false })
                        .limit(limit);
                    if (args.status) q = q.eq('status', args.status);
                    const { data } = await q;
                    return { deployments: data || [], count: (data || []).length };
                }

                // ── INVENTORY ──────────────────────────────────────────────────
                case 'get_inventory_overview': {
                    const [
                        { count: total },
                        { count: stocked },
                        { count: deployed },
                        { count: inRepair },
                        { count: decommissioned }
                    ] = await Promise.all([
                        supabase.from('equipments').select('*', { count: 'exact', head: true }),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'stocked').eq('current_location', 'Warsaw Office'),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'deployed'),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('current_location', 'Warsaw Repairs'),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'decommissioned')
                    ]);
                    // Breakdown by terminal type (stocked)
                    const { data: byType } = await supabase.from('equipments')
                        .select('terminal_type')
                        .eq('status', 'stocked');
                    const typeBreakdown = {};
                    (byType || []).forEach(e => {
                        const t = e.terminal_type || 'Unknown';
                        typeBreakdown[t] = (typeBreakdown[t] || 0) + 1;
                    });
                    return { total, stocked, deployed, in_repair: inRepair, decommissioned, stocked_by_type: typeBreakdown };
                }

                case 'search_inventory': {
                    const limit = args.limit || 15;
                    const { data } = await supabase.from('equipments')
                        .select('id, serial_number, terminal_type, status, current_location, condition, received_date')
                        .or(`serial_number.ilike.%${args.query}%,terminal_type.ilike.%${args.query}%`)
                        .limit(limit);
                    return { equipment: data || [], count: (data || []).length };
                }

                case 'get_inventory_by_location': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('equipments')
                        .select('id, serial_number, terminal_type, status, condition, received_date')
                        .ilike('current_location', `%${args.location}%`)
                        .limit(limit);
                    return { equipment: data || [], count: (data || []).length, location: args.location };
                }

                // ── RETURNS ────────────────────────────────────────────────────
                case 'get_returns_overview': {
                    const [
                        { count: open },
                        { count: pending },
                        { count: completed },
                        { count: defective }
                    ] = await Promise.all([
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('status', 'open'),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('status', 'pending'),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('status', 'completed'),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('condition', '%defective%')
                    ]);
                    const { data: recent } = await supabase.from('returns')
                        .select('return_id, merchant_name, status, return_reason, created_at')
                        .order('created_at', { ascending: false }).limit(5);
                    return { open, pending, completed, defective_units: defective, recent: recent || [] };
                }

                case 'get_returns': {
                    const limit = args.limit || 15;
                    let q = supabase.from('returns')
                        .select('id, return_id, merchant_name, merchant_id, status, return_reason, condition, destination, created_at')
                        .order('created_at', { ascending: false })
                        .limit(limit);
                    if (args.status) q = q.ilike('status', args.status);
                    else q = q.or('status.ilike.open,status.ilike.pending');
                    const { data } = await q;
                    return { returns: data || [], count: (data || []).length };
                }

                // ── OPERATOR read helpers ────────────────────────────────────
                case 'search_prospects': {
                    const q = String(args.query || '').replace(/[%,()]/g, ' ').trim();
                    if (q.length < 2) return { prospects: [] };
                    const { data } = await supabase.from('leads').select('id, full_name, email, status, assigned_rep').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(10);
                    return { prospects: data || [] };
                }
                case 'list_reps': {
                    const { data } = await supabase.from('app_users').select('userid, first_name, last_name, email, role').eq('is_active', true).order('first_name').limit(200);
                    return { reps: (data || []).map(u => ({ userid: u.userid, name: (`${u.first_name || ''} ${u.last_name || ''}`.trim()) || u.email, role: u.role || '' })) };
                }
                case 'find_partner_person': {
                    const q = String(args.query || '').replace(/[%,()]/g, ' ').trim();
                    if (q.length < 2) return { partners: [] };
                    const { data } = await supabase.from('persons').select('id, full_name, email').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(10);
                    return { partners: data || [] };
                }
                case 'list_certificate_designs': {
                    const { data } = await supabase.from('app_settings').select('value').eq('key', 'cert_designs').maybeSingle();
                    let arr = []; try { arr = JSON.parse(data?.value || '[]'); } catch (e) { arr = []; }
                    return { designs: (Array.isArray(arr) ? arr : []).map(d => ({ id: d.id, name: d.name, category: d.category || 'payprotec', is_default: !!d.is_default })) };
                }

                // ── OPERATOR actions: PROPOSE only (never execute here) ───────
                case 'assign_prospect_rep':
                case 'award_certificate':
                case 'update_ticket_status': {
                    const spec = ACTION_SPECS[name];
                    if (!opEnabled) return { error: 'Operator mode is off. An admin can enable "Jarvis Operator" in Secret Dungeon → Feature Flags.' };
                    if (!spec.access(actor)) return { error: 'You do not have permission to perform this action.' };
                    let label = name; try { label = await spec.describe(args || {}); } catch (e) {}
                    pendingAction = { name, args: args || {}, label };
                    return { proposed: true, requires_confirmation: true, summary: label, note: 'Prepared. Tell the user exactly what will happen and that they must click Confirm in the UI. Do NOT claim it is done.' };
                }

                default:
                    return { error: `Unknown tool: ${name}` };
            }
        } catch (e) {
            console.error(`[Jarvis Tool Error] ${name}:`, e.message);
            return { error: e.message };
        }
    }

    try {

        // ── LOAD KNOWLEDGE BASE ───────────────────────────────────────────────
        const { data: knowledgeRows } = await supabase
            .from('jarvis_knowledge')
            .select('topic, correct_logic')
            .order('created_at', { ascending: false })
            .limit(40);

        const knowledgeBlock = (knowledgeRows || []).length > 0
            ? '\n\nINTERNAL KNOWLEDGE BASE (always apply these rules and facts):\n' +
              (knowledgeRows || []).map(k => `• [${k.topic}] ${k.correct_logic}`).join('\n')
            : '';

        // ── CHAT HISTORY ──────────────────────────────────────────────────────
        const { data: history } = await supabase
            .from('chat_history')
            .select('role, content')
            .eq('userid', userId)
            .order('created_at', { ascending: false })
            .limit(12);

        const formattedHistory = (history || []).map(h => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: h.content }]
        })).reverse();

        // ── SYSTEM PROMPT ─────────────────────────────────────────────────────
        const systemInstruction = `You are JARVIS, the AI business intelligence agent for PayProTec's merchant management console. Address the user as ${userName || 'Sir'}.

Your focus areas: Merchants, Partners, Deployments, Inventory, and Returns. You have live database access via tools.

CRITICAL CONVERSATION RULES:
1. Always read the full conversation history before deciding what to do.
2. For follow-up questions ("review it", "what about that merchant", "tell me more", "can you analyze it"), use the data already retrieved in previous messages — do NOT call tools again or ask "what would you like to review?" You already have the context.
3. Pronouns like "it", "that", "this merchant", "the above" always refer to the most recently discussed subject in the conversation history.
4. Only call tools when genuinely NEW data is needed (e.g. a different merchant, a new topic, or refreshing stale data).
5. For greetings or fully off-topic messages, respond briefly.
6. End substantive answers with "**Suggested Actions:**" listing 2-4 concrete next steps.

TOOL USAGE:
- Call tools for fresh data lookups
- Do NOT call tools when you already have the data from this conversation

Formatting: use **bold** for names/numbers, bullet lists for items, keep responses concise.

NAVIGATION ACTIONS — when suggesting a page to visit, use EXACTLY these URL formats (never invent paths):
- Merchant list: → View all merchants (url:/merchants-dashboard.html)
- Search merchants by name: → Search for [name] in merchants (url:/merchants-dashboard.html?q=[name])
- Filter merchants by status: → View [status] merchants (url:/merchants-dashboard.html?filterBy=[status])
- Partners list: → View all partners (url:/partners-dashboard.html)
- Search partners: → Search for [name] in partners (url:/partners-dashboard.html?q=[name])
- Deployments: → View deployments (url:/deployments-dashboard.html)
- Search deployments: → Search deployments (url:/deployments-dashboard.html?q=[term])
- Inventory/Equipment: → View inventory (url:/equipments-dashboard.html)
- Search inventory: → Search inventory (url:/equipments-dashboard.html?q=[term])
- Returns: → View returns (url:/returns-dashboard.html)
- Search returns: → Search returns (url:/returns-dashboard.html?q=[term])
Only include navigation actions when they are genuinely useful. Use real names/values in the URL query params, not placeholder text like [name].

OPERATOR ACTIONS${opEnabled ? ' (ENABLED)' : ' (currently OFF — do not attempt)'}: You can PREPARE these write actions: assign_prospect_rep, award_certificate, update_ticket_status. First resolve exact ids with the read helpers (search_prospects, list_reps, find_partner_person, list_certificate_designs), then call the action tool with those ids. Actions are NEVER executed immediately — they are proposed to the user, who must click Confirm. After calling an action tool, clearly state what you've prepared and that the user must confirm it. NEVER say an action is complete/done — it isn't until the user confirms.` + knowledgeBlock;

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        // ── FOLLOW-UP DETECTION ───────────────────────────────────────────────
        // Only send to the tools-free path when the user is clearly asking for
        // commentary/assessment on data already shown — NOT when they're asking
        // for new data lookups ("analyze his merchants", "show me his volume", etc.)
        const followUpPhrases = /^(review it|summarize( it| that| this)?|tell me more|more detail|explain( it| that| this)?|what do you think|give me a summary|give me a review)/i;
        const isFollowUp = query.trim().length < 120 && followUpPhrases.test(query.trim());

        const hasLastResponse = !!(lastResponse && lastResponse.trim().length > 50);

        const toolCallsLog = [];
        let finalAnswer;

        if (isFollowUp && hasLastResponse) {
            // ── FOLLOW-UP PATH: no tools, assess data already shown ───────────
            // Uses a separate model instance with NO tools registered — Gemini
            // cannot call tools when they're not on the model instance.
            const prevResponse = lastResponse.slice(0, 2000);
            const followUpModel = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction: `You are JARVIS, a business intelligence assistant for PayProTec. Address the user as ${userName || 'Sir'}. You are providing an assessment of data that was already retrieved. Give a direct analytical opinion — comment on status, volume trends, risks, and recommended actions. Use **bold** for key data points. End with "**Suggested Actions:**" listing 2-3 concrete next steps.`
            });
            const r = await followUpModel.generateContent(
                `Previous JARVIS response containing the relevant data:\n"""\n${prevResponse}\n"""\n\nUser follow-up: ${query}\n\nProvide your analytical assessment of the data shown above.`
            );
            try { finalAnswer = r.response.text(); }
            catch { finalAnswer = 'Could not generate follow-up response. Please try rephrasing.'; }

        } else {
            // ── MAIN PATH: full agentic loop with tools ────────────────────────
            // If there's a previous response, inject it at the start of history
            // so the model knows what subject was being discussed (e.g. which
            // partner to look up when asked "analyze his merchants").
            const historyWithContext = hasLastResponse
                ? [
                    { role: 'user', parts: [{ text: 'What was the last thing you showed me?' }] },
                    { role: 'model', parts: [{ text: lastResponse.slice(0, 1500) }] },
                    ...formattedHistory.slice(0, 8)
                  ]
                : formattedHistory;

            const model = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction,
                tools: [{ functionDeclarations }]
            });
            const chat = model.startChat({ history: historyWithContext });
            let result = await chat.sendMessage(query);
            let maxIterations = 8;

            while (maxIterations-- > 0) {
                let calls;
                try { calls = result.response.functionCalls(); } catch { calls = null; }
                if (!calls || calls.length === 0) break;
                const toolResponses = [];
                for (const call of calls) {
                    toolCallsLog.push(call.name);
                    const toolResult = await executeTool(call.name, call.args || {});
                    toolResponses.push({ functionResponse: { name: call.name, response: toolResult } });
                }
                result = await chat.sendMessage(toolResponses);
            }
            try { finalAnswer = result.response.text(); }
            catch { finalAnswer = 'I encountered an issue generating a response. Please try again.'; }
        }

        // ── EXTRACT NAVIGATION SUGGESTIONS ────────────────────────────────────
        const suggestions = [];
        const urlMatches = [...finalAnswer.matchAll(/→\s*([^\n(]+)\(url:([^)]+)\)/g)];
        for (const m of urlMatches) {
            suggestions.push({ label: m[1].trim().replace(/\*\*/g, ''), url: m[2].trim() });
        }
        const cleanAnswer = finalAnswer.replace(/\s*\(url:[^)]+\)/g, '');

        // ── PERSIST HISTORY ───────────────────────────────────────────────────
        try {
            await supabase.from('chat_history').insert([
                { userid: userId, role: 'user', content: query },
                { userid: userId, role: 'assistant', content: cleanAnswer }
            ]);
        } catch { /* non-fatal */ }

        return res.status(200).json({
            answer: cleanAnswer,
            suggestions,
            tools_used: [...new Set(toolCallsLog)],
            pending_action: pendingAction
        });

    } catch (err) {
        console.error('[Jarvis Error]', err?.message || err);
        return res.status(200).json({
            answer: `I hit an error, ${userName || 'Sir'}: ${err?.message || 'Unknown error'}. Please check the server logs.`,
            suggestions: [],
            tools_used: []
        });
    }
}
