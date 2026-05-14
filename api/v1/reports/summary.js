import { createClient } from '@supabase/supabase-js';
import { validateApiKey } from '../_auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function getAgentData(personId) {
    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    if (!agents?.length) return { idStrings: [] };
    const agentUuids = agents.map(a => a.id);
    const { data: identifiers } = await supabase.from('agent_identifiers').select('id_string').in('agent_id', agentUuids);
    return { idStrings: (identifiers || []).map(i => i.id_string) };
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'GET') return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this endpoint.' } });

    const ctx = await validateApiKey(req, res);
    if (!ctx) return;

    const { idStrings } = await getAgentData(ctx.owner_id);

    if (!idStrings.length) {
        return res.json({
            success: true,
            data: {
                merchants: { total: 0, approved: 0, pending: 0, closed: 0, at_risk: 0 },
                volume: { mtd: 0, last_30_days: 0, last_90_days: 0 },
                tickets: { open: 0, in_progress: 0, resolved: 0 },
                generated_at: new Date().toISOString()
            }
        });
    }

    // Run all queries in parallel
    const [statsRes, merchantsRes, ticketsRes] = await Promise.all([
        supabase.from('merchant_stats_by_id')
            .select('merchant_count, pending_count, closed_count, total_volume_sum, total_volume_90d_sum')
            .in('agent_id', idStrings),

        supabase.from('merchants')
            .select('volume_mtd, volume_90_day')
            .in('agent_id', idStrings)
            .eq('account_status', 'Approved'),

        supabase.from('support_tickets')
            .select('status')
            .eq('person_id', ctx.owner_id)
            .not('status', 'in', '(closed)')
    ]);

    // Aggregate merchant stats
    let approved = 0, pending = 0, closed = 0, mtd = 0, vol90 = 0;
    (statsRes.data || []).forEach(s => {
        approved += parseInt(s.merchant_count || 0);
        pending  += parseInt(s.pending_count  || 0);
        closed   += parseInt(s.closed_count   || 0);
        mtd      += parseFloat(s.total_volume_sum  || 0);
        vol90    += parseFloat(s.total_volume_90d_sum || 0);
    });

    // At-risk = approved merchants where MTD is more than 5% below 90-day monthly baseline
    let atRisk = 0;
    (merchantsRes.data || []).forEach(m => {
        const mMtd     = parseFloat(m.volume_mtd    || 0);
        const baseline = parseFloat(m.volume_90_day || 0) / 3;
        if (baseline > 0 && mMtd < baseline * 0.95) atRisk++;
    });

    // Ticket counts by status
    const tickets = { open: 0, in_progress: 0, resolved: 0 };
    (ticketsRes.data || []).forEach(t => {
        if (t.status === 'open')        tickets.open++;
        else if (t.status === 'in_progress') tickets.in_progress++;
        else if (t.status === 'resolved')    tickets.resolved++;
    });

    return res.json({
        success: true,
        data: {
            merchants: {
                total:    approved + pending,
                approved,
                pending,
                closed,
                at_risk:  atRisk
            },
            volume: {
                mtd:          parseFloat(mtd.toFixed(2)),
                last_30_days: parseFloat(mtd.toFixed(2)),
                last_90_days: parseFloat(vol90.toFixed(2))
            },
            tickets,
            generated_at: new Date().toISOString()
        }
    });
}
