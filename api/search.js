import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

function dedup(arr, key) {
    const seen = new Set();
    return arr.filter(item => {
        const k = item[key];
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

function mergeInto(existing, incoming, key, limit = 10) {
    if (!incoming?.length) return existing;
    const seen = new Set(existing.map(x => x[key]));
    const merged = [...existing];
    for (const item of incoming) {
        if (!seen.has(item[key])) { seen.add(item[key]); merged.push(item); }
    }
    return merged.slice(0, limit);
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

    const { q, userid } = req.body;
    if (!userid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!q || q.trim().length < 2) return res.status(400).json({ success: false, message: 'Query too short' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const term = q.trim();
    const like = `%${term}%`;

    const { data: user } = await supabase.from('app_users').select('role, is_active').eq('userid', userid).single();
    if (!user?.is_active) return res.status(403).json({ success: false, message: 'Access denied' });

    const MERCHANT_COLS = 'id, merchant_id, dba_name, account_status, agent_id, agent_name, partner_full_name, merchant_city, merchant_state';
    const TICKET_COLS   = 'id, ticket_number, subject, status, priority, created_at, merchant_id';
    const DEPLOY_COLS   = 'id, deployment_id, tracking_id, status, created_at, merchant_id, tid';
    const RETURN_COLS   = 'id, return_id, return_reason, status, return_date_initiated, merchant_id';
    const TASK_COLS     = 'id, title, status, priority, due_date, assigned_to, merchant_id';

    try {
        // ── PASS 1: Direct field searches (all parallel) ────────────────────────
        const [
            merchantsByDba, merchantsByMid, merchantsByAgent, merchantsByPartner,
            ticketsByNumber, ticketsBySubject,
            partnersByName, partnersByEmail, partnersByPhone,
            equipBySerial, equipByModel,
            agentIdsRes,
            deploysByTracking, deploysByDepId,
            returnsByRmaId,
            tasksByTitle, tasksByBody,
        ] = await Promise.all([
            supabase.from('merchant_portfolio_view').select(MERCHANT_COLS).ilike('dba_name', like).limit(12),
            supabase.from('merchant_portfolio_view').select(MERCHANT_COLS).ilike('merchant_id', like).limit(12),
            supabase.from('merchant_portfolio_view').select(MERCHANT_COLS).ilike('agent_name', like).limit(12),
            supabase.from('merchant_portfolio_view').select(MERCHANT_COLS).ilike('partner_full_name', like).limit(12),
            supabase.from('support_tickets').select(TICKET_COLS).ilike('ticket_number', like).order('created_at', { ascending: false }).limit(10),
            supabase.from('support_tickets').select(TICKET_COLS).ilike('subject', like).order('created_at', { ascending: false }).limit(10),
            supabase.from('persons').select('id, full_name, email, phone_number, is_portal_active').ilike('full_name', like).limit(10),
            supabase.from('persons').select('id, full_name, email, phone_number, is_portal_active').ilike('email', like).limit(10),
            supabase.from('persons').select('id, full_name, email, phone_number, is_portal_active').ilike('phone_number', like).limit(10),
            supabase.from('equipments').select('id, serial_number, terminal_type, status, current_location').ilike('serial_number', like).limit(10),
            supabase.from('equipments').select('id, serial_number, terminal_type, status, current_location').ilike('terminal_type', like).limit(10),
            supabase.from('agent_identifiers').select('id_string, agent_id').ilike('id_string', like).limit(8),
            supabase.from('deployments').select(DEPLOY_COLS).ilike('tracking_id', like).order('created_at', { ascending: false }).limit(10),
            supabase.from('deployments').select(DEPLOY_COLS).ilike('deployment_id', like).order('created_at', { ascending: false }).limit(10),
            supabase.from('returns').select(RETURN_COLS).ilike('return_id', like).order('return_date_initiated', { ascending: false }).limit(10),
            supabase.from('merchant_tasks').select(TASK_COLS).ilike('title', like).order('due_date', { ascending: true }).limit(10),
            supabase.from('merchant_tasks').select(TASK_COLS).ilike('body', like).order('due_date', { ascending: true }).limit(10),
        ]);

        // Merge + dedup (mutable so cross-refs can expand them)
        let merchants = dedup([
            ...(merchantsByDba.data     || []).map(m => ({ ...m, _matchedBy: 'dba_name' })),
            ...(merchantsByMid.data     || []).map(m => ({ ...m, _matchedBy: 'merchant_id' })),
            ...(merchantsByAgent.data   || []).map(m => ({ ...m, _matchedBy: 'agent_name' })),
            ...(merchantsByPartner.data || []).map(m => ({ ...m, _matchedBy: 'partner_full_name' })),
        ], 'merchant_id').slice(0, 15);

        let tickets     = dedup([...(ticketsByNumber.data || []), ...(ticketsBySubject.data || [])], 'id').slice(0, 10);
        let partners    = dedup([...(partnersByName.data  || []), ...(partnersByEmail.data  || []), ...(partnersByPhone.data || [])], 'id').slice(0, 10);
        const equipment = dedup([...(equipBySerial.data   || []), ...(equipByModel.data    || [])], 'id').slice(0, 10);
        let deployments = dedup([...(deploysByTracking.data || []), ...(deploysByDepId.data || [])], 'id').slice(0, 10);
        let returns     = (returnsByRmaId.data || []).slice(0, 10);
        const tasks     = dedup([...(tasksByTitle.data || []), ...(tasksByBody.data || [])], 'id').slice(0, 10);
        const rawAgentIds = agentIdsRes.data || [];

        // ── PASS 2: Partner & agent-ID cross-references ─────────────────────────
        const partnerPersonIds = partners.map(p => p.id);
        const rawAgentUuids   = rawAgentIds.map(a => a.agent_id).filter(Boolean);

        const [linkedAgentsRes, agentIdAgentsRes, agentMerchantsRes] = await Promise.all([
            // Agents linked to found partners (to get their agent ID strings)
            partnerPersonIds.length
                ? supabase.from('agents').select('id, parent_agent_id').in('parent_agent_id', partnerPersonIds)
                : { data: [] },
            // Agents for found agent-ID strings (to resolve → partner name)
            rawAgentUuids.length
                ? supabase.from('agents').select('id, parent_agent_id').in('id', rawAgentUuids)
                : { data: [] },
            // Merchants belonging to the matched agent IDs (agent ID search → their merchants)
            rawAgentUuids.length
                ? supabase.from('merchant_portfolio_view').select(MERCHANT_COLS).in('agent_id', rawAgentUuids).limit(10)
                : { data: [] },
        ]);

        const linkedAgentUuids       = (linkedAgentsRes.data || []).map(a => a.id);
        const linkedAgentToPersonMap = Object.fromEntries((linkedAgentsRes.data || []).map(a => [a.id, a.parent_agent_id]));
        const agentIdParentUuids     = (agentIdAgentsRes.data || []).map(a => a.parent_agent_id).filter(Boolean);

        const [agentStringsForPartnersRes, partnerMerchantsRes, agentIdPersonsRes] = await Promise.all([
            // Agent ID strings for found partners (shown in partner rows)
            linkedAgentUuids.length
                ? supabase.from('agent_identifiers').select('id_string, agent_id').in('agent_id', linkedAgentUuids)
                : { data: [] },
            // Merchants linked to found partners (cross-ref: email → partner → merchants)
            partnerPersonIds.length
                ? supabase.from('merchant_portfolio_view').select(MERCHANT_COLS)
                      .in('partner_full_name', partners.map(p => p.full_name).filter(Boolean)).limit(15)
                : { data: [] },
            // Persons for agent-ID resolution → partner name display
            agentIdParentUuids.length
                ? supabase.from('persons').select('id, full_name, email').in('id', agentIdParentUuids)
                : { data: [] },
        ]);

        // Enrich partners with their agent ID strings
        const personAgentIdsMap = {};
        (agentStringsForPartnersRes.data || []).forEach(ai => {
            const personId = linkedAgentToPersonMap[ai.agent_id];
            if (personId) (personAgentIdsMap[personId] = personAgentIdsMap[personId] || []).push(ai.id_string);
        });
        partners = partners.map(p => ({ ...p, agent_ids: personAgentIdsMap[p.id] || [] }));

        // Merge cross-ref merchants: partner found → pull their merchants
        merchants = mergeInto(merchants, (partnerMerchantsRes.data || []).map(m => ({ ...m, _matchedBy: 'partner_link' })), 'merchant_id', 15);

        // Merge cross-ref merchants: agent ID string found → pull their merchants
        merchants = mergeInto(merchants, (agentMerchantsRes.data || []).map(m => ({ ...m, _matchedBy: 'agent_link' })), 'merchant_id', 15);

        // Resolve agent-ID search results → partner name for display
        const agentIdAgentMap  = Object.fromEntries((agentIdAgentsRes.data || []).map(a => [a.id, a]));
        const agentIdPersonMap = Object.fromEntries((agentIdPersonsRes.data || []).map(p => [p.id, p]));
        const agentIdResults   = rawAgentIds.map(ai => {
            const agent  = agentIdAgentMap[ai.agent_id];
            const person = agent ? agentIdPersonMap[agent.parent_agent_id] : null;
            return { id_string: ai.id_string, partner_name: person?.full_name || null, partner_email: person?.email || null };
        });

        // ── PASS 3: Merchant-linked cross-refs + name enrichment ────────────────
        const allMerchantUuids = [...new Set(merchants.map(m => m.id).filter(Boolean))];

        const [crossTicketsRes, crossDeploysRes, crossReturnsRes, merchantNameRes] = await Promise.all([
            // Tickets for found merchants (merchant search → their tickets)
            allMerchantUuids.length
                ? supabase.from('support_tickets').select(TICKET_COLS).in('merchant_id', allMerchantUuids).order('created_at', { ascending: false }).limit(10)
                : { data: [] },
            // Deployments for found merchants (merchant/partner search → their deployments)
            allMerchantUuids.length
                ? supabase.from('deployments').select(DEPLOY_COLS).in('merchant_id', allMerchantUuids).order('created_at', { ascending: false }).limit(10)
                : { data: [] },
            // Returns for found merchants
            allMerchantUuids.length
                ? supabase.from('returns').select(RETURN_COLS).in('merchant_id', allMerchantUuids).order('return_date_initiated', { ascending: false }).limit(10)
                : { data: [] },
            // Merchant names for all enrichments
            allMerchantUuids.length
                ? supabase.from('merchants').select('id, dba_name').in('id', allMerchantUuids)
                : { data: [] },
        ]);

        tickets     = mergeInto(tickets,     crossTicketsRes.data, 'id', 10);
        deployments = mergeInto(deployments, crossDeploysRes.data, 'id', 10);
        returns     = mergeInto(returns,     crossReturnsRes.data, 'id', 10);

        const merchantNameMap = Object.fromEntries((merchantNameRes.data || []).map(m => [m.id, m.dba_name]));

        // Top up name map for tasks that reference merchants not in our set
        const taskMissingIds = [...new Set(tasks.map(t => t.merchant_id).filter(id => id && !merchantNameMap[id]))];
        if (taskMissingIds.length) {
            const { data: tm } = await supabase.from('merchants').select('id, dba_name').in('id', taskMissingIds);
            if (tm) tm.forEach(m => { merchantNameMap[m.id] = m.dba_name; });
        }

        const deploymentsEnriched = deployments.map(d => ({ ...d, merchant_name: merchantNameMap[d.merchant_id] || null }));
        const returnsEnriched     = returns.map(r => ({ ...r, merchant_name: merchantNameMap[r.merchant_id] || null }));
        const tasksEnriched       = tasks.map(t => ({ ...t, merchant_name: merchantNameMap[t.merchant_id] || null }));

        return res.status(200).json({
            success: true,
            results: {
                merchants,
                partners,
                agent_ids: agentIdResults,
                tickets,
                equipment,
                deployments: deploymentsEnriched,
                returns: returnsEnriched,
                tasks: tasksEnriched,
            }
        });
    } catch (err) {
        console.error('Search API error:', err.message);
        return res.status(500).json({ success: false, message: 'Search failed' });
    }
}
