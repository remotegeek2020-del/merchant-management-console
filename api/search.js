import { createClient } from '@supabase/supabase-js';

function dedup(arr, key) {
    const seen = new Set();
    return arr.filter(item => {
        const k = item[key];
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

    const { q, userid } = req.body;
    if (!userid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!q || q.trim().length < 2) return res.status(400).json({ success: false, message: 'Query too short' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const term = q.trim();
    const like = `%${term}%`;

    const { data: user } = await supabase.from('app_users').select('role, is_active').eq('userid', userid).single();
    if (!user?.is_active) return res.status(403).json({ success: false, message: 'Access denied' });

    const MERCHANT_COLS = 'id, merchant_id, dba_name, account_status, agent_id, agent_name, partner_full_name';

    try {
        const [
            merchantsByDba, merchantsByMid, merchantsByAgent, merchantsByPartner,
            ticketsByNumber, ticketsBySubject,
            partnersByName, partnersByEmail, partnersByPhone,
            equipBySerial, equipByModel,
            agentIdsRes,
            deploysByTracking,
            returnsByRmaId,
        ] = await Promise.all([
            // Merchants — 4 fields
            supabase.from('merchant_portfolio_view').select(MERCHANT_COLS).ilike('dba_name', like).limit(6),
            supabase.from('merchant_portfolio_view').select(MERCHANT_COLS).ilike('merchant_id', like).limit(6),
            supabase.from('merchant_portfolio_view').select(MERCHANT_COLS).ilike('agent_name', like).limit(6),
            supabase.from('merchant_portfolio_view').select(MERCHANT_COLS).ilike('partner_full_name', like).limit(6),

            // Tickets
            supabase.from('support_tickets').select('id, ticket_number, subject, status, priority').ilike('ticket_number', like).order('created_at', { ascending: false }).limit(5),
            supabase.from('support_tickets').select('id, ticket_number, subject, status, priority').ilike('subject', like).order('created_at', { ascending: false }).limit(5),

            // Partners — 3 fields
            supabase.from('persons').select('id, full_name, email, is_portal_active').ilike('full_name', like).limit(6),
            supabase.from('persons').select('id, full_name, email, is_portal_active').ilike('email', like).limit(6),
            supabase.from('persons').select('id, full_name, email, is_portal_active').ilike('phone_number', like).limit(6),

            // Equipment
            supabase.from('equipments').select('id, serial_number, terminal_type, status, current_location').ilike('serial_number', like).limit(5),
            supabase.from('equipments').select('id, serial_number, terminal_type, status, current_location').ilike('terminal_type', like).limit(5),

            // Agent IDs
            supabase.from('agent_identifiers').select('id_string, agent_id').ilike('id_string', like).limit(5),

            // Deployments by tracking ID or deployment ID
            supabase.from('deployments').select('id, deployment_id, tracking_id, status, created_at').ilike('tracking_id', like).order('created_at', { ascending: false }).limit(5),

            // Returns by RMA ID
            supabase.from('returns').select('id, return_id, return_reason, status, return_date_initiated').ilike('return_id', like).order('return_date_initiated', { ascending: false }).limit(5),
        ]);

        // Merge + dedup merchants, tagging which field matched
        const byDba     = (merchantsByDba.data     || []).map(m => ({ ...m, _matchedBy: 'dba_name' }));
        const byMid     = (merchantsByMid.data     || []).map(m => ({ ...m, _matchedBy: 'merchant_id' }));
        const byAgent   = (merchantsByAgent.data   || []).map(m => ({ ...m, _matchedBy: 'agent_name' }));
        const byPartner = (merchantsByPartner.data || []).map(m => ({ ...m, _matchedBy: 'partner_full_name' }));
        const merchants = dedup([...byDba, ...byMid, ...byAgent, ...byPartner], 'merchant_id').slice(0, 8);

        const tickets = dedup(
            [...(ticketsByNumber.data || []), ...(ticketsBySubject.data || [])],
            'id'
        ).slice(0, 5);

        const partners = dedup(
            [...(partnersByName.data || []), ...(partnersByEmail.data || []), ...(partnersByPhone.data || [])],
            'id'
        ).slice(0, 6);

        const equipment = dedup(
            [...(equipBySerial.data || []), ...(equipByModel.data || [])],
            'id'
        ).slice(0, 5);

        const deployments = (deploysByTracking.data || []).slice(0, 5);
        const returns     = (returnsByRmaId.data    || []).slice(0, 5);

        // Resolve agent IDs → partner name via agents → persons join
        let agentIdResults = [];
        const rawAgentIds = agentIdsRes.data || [];
        if (rawAgentIds.length) {
            const agentUuids = rawAgentIds.map(a => a.agent_id).filter(Boolean);
            const { data: agents } = await supabase
                .from('agents').select('id, parent_agent_id').in('id', agentUuids);

            const personUuids = (agents || []).map(a => a.parent_agent_id).filter(Boolean);
            const { data: persons } = personUuids.length
                ? await supabase.from('persons').select('id, full_name, email').in('id', personUuids)
                : { data: [] };

            const agentMap  = Object.fromEntries((agents  || []).map(a => [a.id, a]));
            const personMap = Object.fromEntries((persons || []).map(p => [p.id, p]));

            agentIdResults = rawAgentIds.map(ai => {
                const agent  = agentMap[ai.agent_id];
                const person = agent ? personMap[agent.parent_agent_id] : null;
                return { id_string: ai.id_string, partner_name: person?.full_name || null, partner_email: person?.email || null };
            });
        }

        return res.status(200).json({
            success: true,
            results: { merchants, partners, agent_ids: agentIdResults, tickets, equipment, deployments, returns }
        });
    } catch (err) {
        console.error('Search API error:', err.message);
        return res.status(500).json({ success: false, message: 'Search failed' });
    }
}
