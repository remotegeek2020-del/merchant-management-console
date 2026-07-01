import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

// Proactive SLA / aging alerts. Scans tickets, tasks, deployments, returns for
// items past their threshold and drops in-app notifications (type='alert') to
// the item's owner + ops admins. Deduped per item per day via alert_key.
//
// GET  (cron, Authorization: Bearer CRON_SECRET) — scheduled hourly.
// POST (staff super_admin session) — "Run alerts now" from Secret Dungeon.

const DEFAULT_THRESHOLDS = {
    ticket_sla_hours: { high: 24, urgent: 8, normal: 72, low: 168 },
    deployment_stuck_days: 10,
    return_open_days: 14,
    tasks_overdue: true
};

function hoursAgo(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 36e5 : 0; }
function daysAgo(iso) { return hoursAgo(iso) / 24; }

async function runAlerts(supabase) {
    // Config (thresholds + enabled) from app_settings
    const { data: cfgRows } = await supabase.from('app_settings').select('key, value')
        .in('key', ['alerts_enabled', 'alert_thresholds']);
    const cfg = Object.fromEntries((cfgRows || []).map(r => [r.key, r.value]));
    if (cfg.alerts_enabled === 'false') return { skipped: 'disabled' };
    let TH = DEFAULT_THRESHOLDS;
    try { if (cfg.alert_thresholds) TH = { ...DEFAULT_THRESHOLDS, ...JSON.parse(cfg.alert_thresholds) }; } catch {}

    // Default recipients = active super_admins + Operations Admins
    const { data: admins } = await supabase.from('app_users')
        .select('userid, role, is_active');
    const adminIds = (admins || [])
        .filter(u => u.is_active !== false && ['super_admin', 'operations admin', 'operations_admin'].includes(String(u.role || '').toLowerCase()))
        .map(u => u.userid);

    const findings = []; // { alert_key, recipients:[userid], title, body, merchant_id }

    // ── Tickets past SLA (by priority) ──
    const { data: tickets } = await supabase.from('support_tickets')
        .select('id, ticket_number, subject, priority, status, assigned_to, created_at, merchant_id')
        .not('status', 'in', '("closed","resolved","Closed","Resolved")')
        .limit(500);
    for (const t of (tickets || [])) {
        const pri = String(t.priority || 'normal').toLowerCase();
        const sla = TH.ticket_sla_hours[pri] ?? TH.ticket_sla_hours.normal ?? 72;
        const age = hoursAgo(t.created_at);
        if (age >= sla) {
            findings.push({
                alert_key: `ticket_sla:${t.id}`,
                recipients: [t.assigned_to, ...adminIds].filter(Boolean),
                title: `⏰ Ticket past SLA: #${t.ticket_number || ''}`,
                body: `${t.subject || 'Ticket'} — open ${Math.round(age)}h (SLA ${sla}h, ${pri})`,
                merchant_id: t.merchant_id
            });
        }
    }

    // ── Tasks overdue ──
    if (TH.tasks_overdue) {
        const nowIso = new Date().toISOString();
        const { data: tasks } = await supabase.from('merchant_tasks')
            .select('id, title, due_date, assigned_to, status, merchant_id')
            .neq('status', 'Completed').not('due_date', 'is', null).lt('due_date', nowIso)
            .limit(500);
        for (const tk of (tasks || [])) {
            findings.push({
                alert_key: `task_overdue:${tk.id}`,
                recipients: [tk.assigned_to, ...adminIds].filter(Boolean),
                title: `⏰ Task overdue`,
                body: `${tk.title || 'Task'} — was due ${String(tk.due_date).slice(0, 10)}`,
                merchant_id: tk.merchant_id, task_id: tk.id
            });
        }
    }

    // ── Deployments stuck (Open / In Transit too long) ──
    const { data: deps } = await supabase.from('deployments')
        .select('id, deployment_id, status, created_at, created_by, merchant_id')
        .in('status', ['Open', 'In Transit']).limit(500);
    for (const d of (deps || [])) {
        const days = daysAgo(d.created_at);
        if (days >= (TH.deployment_stuck_days || 10)) {
            findings.push({
                alert_key: `deploy_stuck:${d.id}`,
                recipients: [d.created_by, ...adminIds].filter(Boolean),
                title: `⏰ Deployment stuck: ${d.deployment_id || ''}`,
                body: `Status "${d.status}" for ${Math.round(days)} days`,
                merchant_id: d.merchant_id
            });
        }
    }

    // ── Returns aging (Open too long) ──
    const { data: rets } = await supabase.from('returns')
        .select('id, return_id, status, return_date_initiated, created_at, created_by, merchant_id')
        .eq('status', 'Open').limit(500);
    for (const r of (rets || [])) {
        const days = daysAgo(r.return_date_initiated || r.created_at);
        if (days >= (TH.return_open_days || 14)) {
            findings.push({
                alert_key: `return_aging:${r.id}`,
                recipients: [r.created_by, ...adminIds].filter(Boolean),
                title: `⏰ RMA aging: ${r.return_id || ''}`,
                body: `Return open ${Math.round(days)} days`,
                merchant_id: r.merchant_id
            });
        }
    }

    if (!findings.length) return { scanned: 0, created: 0 };

    // Resolve merchant names
    const mids = [...new Set(findings.map(f => f.merchant_id).filter(Boolean))];
    let mNames = {};
    if (mids.length) {
        const { data: ms } = await supabase.from('merchants').select('id, dba_name').in('id', mids);
        (ms || []).forEach(m => { mNames[m.id] = m.dba_name; });
    }

    // Build the (user, alert_key) rows, then dedup against alerts created in the last 24h
    const rows = [];
    for (const f of findings) {
        for (const uid of [...new Set(f.recipients)]) {
            rows.push({
                user_id: uid, type: 'alert', alert_key: f.alert_key,
                title: f.title, body: f.body,
                merchant_id: f.merchant_id || null, merchant_name: f.merchant_id ? (mNames[f.merchant_id] || null) : null,
                task_id: f.task_id || null, from_name: 'System', is_read: false
            });
        }
    }
    const keys = [...new Set(rows.map(r => r.alert_key))];
    const since = new Date(Date.now() - 24 * 36e5).toISOString();
    const { data: existing } = await supabase.from('user_notifications')
        .select('user_id, alert_key').in('alert_key', keys).gt('created_at', since);
    const seen = new Set((existing || []).map(e => `${e.user_id}|${e.alert_key}`));
    const toInsert = rows.filter(r => !seen.has(`${r.user_id}|${r.alert_key}`));

    if (toInsert.length) {
        // insert in chunks to be safe
        for (let i = 0; i < toInsert.length; i += 500) {
            await supabase.from('user_notifications').insert(toInsert.slice(i, i + 500));
        }
    }
    return { findings: findings.length, created: toInsert.length, skipped_dupes: rows.length - toInsert.length };
}

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Manual run (Secret Dungeon) — super_admin session
    if (req.method === 'POST') {
        const session = await validateSession(req);
        if (!session) return res.status(401).json({ success: false, message: 'Unauthorized' });
        const { data: caller } = await supabase.from('app_users').select('role').eq('userid', session.userid).maybeSingle();
        if (String(caller?.role || '').toLowerCase() !== 'super_admin') return res.status(403).json({ success: false, message: 'Super admin only' });
        try { const r = await runAlerts(supabase); return res.status(200).json({ success: true, ...r }); }
        catch (e) { console.error('[alerts]', e.message); return res.status(500).json({ success: false, message: e.message }); }
    }

    if (req.method !== 'GET') return res.status(405).json({ success: false });
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    try {
        const r = await runAlerts(supabase);
        console.log('[CRON] Alerts:', JSON.stringify(r));
        return res.status(200).json({ success: true, ...r });
    } catch (err) {
        console.error('[CRON] Alerts error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
