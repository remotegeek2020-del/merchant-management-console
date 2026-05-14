import { createClient } from '@supabase/supabase-js';
import { validateApiKey } from './_auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'GET') return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this endpoint.' } });

    const ctx = await validateApiKey(req, res);
    if (!ctx) return;

    const [personRes, agentRes] = await Promise.all([
        supabase.from('persons').select('id, full_name, email, phone_number, enrolled_at, last_portal_login').eq('id', ctx.owner_id).single(),
        supabase.from('agents').select('id, company_id, companies:company_id(company_name)').eq('parent_agent_id', ctx.owner_id)
    ]);

    if (!personRes.data) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Partner not found.' } });

    const agents = agentRes.data || [];
    const agentUuids = agents.map(a => a.id);

    let totalMerchants = 0;
    let openTickets = 0;

    if (agentUuids.length) {
        const { data: identifiers } = await supabase.from('agent_identifiers').select('id_string').in('agent_id', agentUuids);
        const idStrings = (identifiers || []).map(i => i.id_string);

        if (idStrings.length) {
            const [merchantCount, ticketCount] = await Promise.all([
                supabase.from('merchants').select('id', { count: 'exact', head: true }).in('agent_id', idStrings),
                supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('person_id', ctx.owner_id).not('status', 'in', '(closed,resolved)')
            ]);
            totalMerchants = merchantCount.count || 0;
            openTickets = ticketCount.count || 0;
        }
    }

    return res.json({
        success: true,
        data: {
            ...personRes.data,
            companies: agents.map(a => a.companies?.company_name).filter(Boolean),
            stats: {
                total_merchants: totalMerchants,
                open_tickets: openTickets
            }
        }
    });
}
