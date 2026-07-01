import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Monday (UTC) of the week containing d, as YYYY-MM-DD
function weekStart(d) {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x.toISOString().slice(0, 10);
}
function monthKey(d) { const x = new Date(d); return x.toISOString().slice(0, 7); }

async function countBy(table, col, val, extra) {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    if (col) q = q.eq(col, val);
    if (extra) q = extra(q);
    const { count } = await q;
    return count || 0;
}
async function fetchCol(table, cols, sinceCol, sinceIso, cap = 6000) {
    let rows = [], off = 0, done = false;
    while (!done) {
        let q = supabase.from(table).select(cols).order(sinceCol, { ascending: false }).range(off, off + 999);
        if (sinceCol && sinceIso) q = q.gte(sinceCol, sinceIso);
        const { data } = await q;
        if (!data || !data.length) done = true;
        else { rows = rows.concat(data); off += 1000; if (data.length < 1000 || off >= cap) done = true; }
    }
    return rows;
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    res.setHeader('Content-Type', 'application/json');
    const action = (req.body && req.body.action) || 'overview';

    try {
        if (action !== 'overview') return res.status(400).json({ success: false, message: 'Unknown action' });

        const now = Date.now();
        const d90 = new Date(now - 90 * 86400000).toISOString();
        const d180 = new Date(now - 180 * 86400000).toISOString();

        // 13 week buckets (oldest → newest)
        const weeks = [];
        for (let i = 12; i >= 0; i--) weeks.push(weekStart(new Date(now - i * 7 * 86400000)));
        const zero = () => Object.fromEntries(weeks.map(w => [w, 0]));

        const [depRows, retRows, tkCreated, tkResolved, merRows] = await Promise.all([
            fetchCol('deployments', 'created_at', 'created_at', d90),
            fetchCol('returns', 'created_at', 'created_at', d90),
            fetchCol('support_tickets', 'created_at', 'created_at', d90),
            fetchCol('support_tickets', 'created_at, resolved_at', 'resolved_at', d90),
            fetchCol('merchants', 'created_at', 'created_at', d180)
        ]);

        const bucket = (rows, dateField) => {
            const m = zero();
            for (const r of rows) {
                const w = weekStart(r[dateField] || r.created_at);
                if (w in m) m[w]++;
            }
            return weeks.map(w => m[w]);
        };

        // New merchants per month (last 6)
        const months = [];
        for (let i = 5; i >= 0; i--) { const dt = new Date(now); dt.setUTCMonth(dt.getUTCMonth() - i); months.push(dt.toISOString().slice(0, 7)); }
        const mMap = Object.fromEntries(months.map(x => [x, 0]));
        for (const r of merRows) { const k = monthKey(r.created_at); if (k in mMap) mMap[k]++; }

        // Status breakdowns + KPIs (cheap head counts)
        const [
            depOpen, depTransit, depClosed,
            retOpen, retClosed,
            tkOpen, tkResolvedC, tkClosed,
            eqStocked, eqDeployed, eqPending, eqDecomm
        ] = await Promise.all([
            countBy('deployments', 'status', 'Open'),
            countBy('deployments', 'status', 'In Transit'),
            countBy('deployments', 'status', 'Closed'),
            countBy('returns', 'status', 'Open'),
            countBy('returns', 'status', 'Closed'),
            countBy('support_tickets', 'status', 'open'),
            countBy('support_tickets', 'status', 'resolved'),
            countBy('support_tickets', 'status', 'closed'),
            countBy('equipments', 'status', 'stocked'),
            countBy('equipments', 'status', 'deployed'),
            countBy('equipments', 'status', 'pending_return'),
            countBy('equipments', 'status', 'decommissioned')
        ]);

        // Avg ticket resolution time (hours), from resolved tickets in the window
        let avgResH = null;
        const resolvedPairs = tkResolved.filter(r => r.resolved_at && r.created_at);
        if (resolvedPairs.length) {
            const total = resolvedPairs.reduce((s, r) => s + (new Date(r.resolved_at) - new Date(r.created_at)), 0);
            avgResH = Math.round((total / resolvedPairs.length) / 36e5);
        }

        const utilBase = eqStocked + eqDeployed;
        return res.status(200).json({
            success: true,
            kpis: {
                open_tickets: tkOpen,
                open_deployments: depOpen + depTransit,
                open_returns: retOpen,
                equip_deployed: eqDeployed,
                equip_stocked: eqStocked,
                utilization_pct: utilBase ? Math.round((eqDeployed / utilBase) * 100) : 0,
                avg_ticket_resolution_h: avgResH
            },
            series: {
                weeks,
                deployments: bucket(depRows, 'created_at'),
                returns: bucket(retRows, 'created_at'),
                tickets_created: bucket(tkCreated, 'created_at'),
                tickets_resolved: bucket(resolvedPairs, 'resolved_at')
            },
            breakdowns: {
                deployments_status: { 'Open': depOpen, 'In Transit': depTransit, 'Closed': depClosed },
                returns_status: { 'Open': retOpen, 'Closed': retClosed },
                tickets_status: { 'Open': tkOpen, 'Resolved': tkResolvedC, 'Closed': tkClosed },
                equipment_status: { 'Stocked': eqStocked, 'Deployed': eqDeployed, 'Pending Return': eqPending, 'Decommissioned': eqDecomm }
            },
            new_merchants_monthly: { labels: months, counts: months.map(m => mMap[m]) }
        });
    } catch (err) {
        console.error('[analytics]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
