// ── DAILY TASK DIGEST ─────────────────────────────────────────────────────────
// Emails opted-in staff a daily summary of their PENDING tasks and the tasks they
// COMPLETED yesterday, with a button back to the Task Center. Managers can receive
// a copy of a staff member's digest (cc_user_ids on that staff member's prefs).
//
// - sendTaskDigests(opts) is used by the hourly cron (api/cron-task-digest.js).
// - The default export is the admin API (get_config / save_config / send_test),
//   surfaced in Secret Dungeon → System Reports.

import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SITE_URL   = process.env.SITE_URL || 'https://portal.mypayprotec.com';
const TASKS_URL  = `${SITE_URL}/tasks-dashboard`;
const DEFAULT_HOUR_UTC = 13;   // ~8–9am US Eastern

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function getSendHour() {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'task_digest_hour_utc').maybeSingle();
    const h = parseInt(data?.value, 10);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? h : DEFAULT_HOUR_UTC;
}

// UTC boundaries for "yesterday" relative to now.
function yesterdayRange() {
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const yStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    return { startIso: yStart.toISOString(), endIso: todayStart.toISOString() };
}

function priorityBadge(p) {
    const map = { High: '#dc2626', Normal: '#0369a1', Low: '#94a3b8' };
    const c = map[p] || '#64748b';
    return `<span style="display:inline-block;font-size:10px;font-weight:700;color:#fff;background:${c};border-radius:4px;padding:1px 6px;">${esc(p || 'Normal')}</span>`;
}

function taskRows(tasks, mNames, showDue) {
    if (!tasks.length) return `<tr><td style="padding:10px 14px;color:#94a3b8;font-size:13px;">Nothing here.</td></tr>`;
    return tasks.map(t => {
        const dba = mNames[t.merchant_id] || '';
        const overdue = showDue && t.due_date && new Date(t.due_date) < new Date();
        const due = t.due_date ? `<span style="color:${overdue ? '#dc2626' : '#64748b'};font-size:11px;">Due ${esc(t.due_date)}${overdue ? ' (overdue)' : ''}</span>` : '';
        return `<tr style="border-top:1px solid #eef2f7;">
            <td style="padding:10px 14px;">
                <div style="font-weight:700;font-size:13px;color:#0f172a;">${esc(t.title || 'Untitled task')}</div>
                ${dba ? `<div style="font-size:12px;color:#64748b;">${esc(dba)}</div>` : ''}
                <div style="margin-top:3px;">${priorityBadge(t.priority)} ${due}</div>
            </td>
        </tr>`;
    }).join('');
}

function buildHtml(name, pending, completed, mNames) {
    return `<div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
        <div style="background:linear-gradient(135deg,#004990,#0369a1);color:#fff;padding:22px 24px;border-radius:14px 14px 0 0;">
            <div style="font-size:19px;font-weight:800;">Your Task Summary</div>
            <div style="font-size:13px;opacity:.9;margin-top:2px;">Good morning${name ? ', ' + esc(name) : ''} — here's where things stand.</div>
        </div>
        <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;padding:20px 22px;background:#fff;">
            <div style="display:flex;gap:12px;margin-bottom:18px;">
                <div style="flex:1;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:12px;text-align:center;">
                    <div style="font-size:26px;font-weight:800;color:#c2410c;">${pending.length}</div>
                    <div style="font-size:11px;font-weight:700;color:#9a3412;text-transform:uppercase;letter-spacing:.4px;">Pending</div>
                </div>
                <div style="flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:12px;text-align:center;">
                    <div style="font-size:26px;font-weight:800;color:#15803d;">${completed.length}</div>
                    <div style="font-size:11px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.4px;">Done Yesterday</div>
                </div>
            </div>

            <div style="font-size:13px;font-weight:800;color:#c2410c;margin:0 0 6px;">⏳ Pending tasks</div>
            <table style="width:100%;border-collapse:collapse;border:1px solid #eef2f7;border-radius:8px;overflow:hidden;margin-bottom:20px;">${taskRows(pending, mNames, true)}</table>

            <div style="font-size:13px;font-weight:800;color:#15803d;margin:0 0 6px;">✅ Completed yesterday</div>
            <table style="width:100%;border-collapse:collapse;border:1px solid #eef2f7;border-radius:8px;overflow:hidden;margin-bottom:22px;">${taskRows(completed, mNames, false)}</table>

            <a href="${TASKS_URL}" style="display:block;text-align:center;background:#004990;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:13px;border-radius:10px;">Open my Task Center →</a>
            <div style="font-size:11px;color:#94a3b8;text-align:center;margin-top:14px;">You're receiving this because daily task emails are enabled for your account.</div>
        </div>
    </div>`;
}

// Core: build + send digests. opts: { force (skip hour gate), onlyUser (test one), trigger }
export async function sendTaskDigests(opts = {}) {
    const { force = false, onlyUser = null, trigger = 'cron' } = opts;

    if (!force) {
        const hour = await getSendHour();
        if (new Date().getUTCHours() !== hour) return { skipped: true, reason: `not send hour (${hour} UTC)` };
    }

    // Who gets a digest.
    let prefQ = supabase.from('task_digest_prefs').select('user_id, enabled, cc_user_ids').eq('enabled', true);
    if (onlyUser) prefQ = supabase.from('task_digest_prefs').select('user_id, enabled, cc_user_ids').eq('user_id', onlyUser);
    const { data: prefs } = await prefQ;
    let targets = (prefs || []).filter(p => onlyUser ? true : p.enabled);
    // A test always sends to the chosen user, even if they have no saved prefs yet.
    if (onlyUser && !targets.length) targets = [{ user_id: onlyUser, cc_user_ids: [] }];
    if (!targets.length) return { sent: 0, skipped: true, reason: 'no enabled users' };

    // Staff directory (userid → email/name).
    const { data: users } = await supabase.from('app_users').select('userid, first_name, last_name, email');
    const uMap = {};
    (users || []).forEach(u => { uMap[u.userid] = { email: u.email, name: `${u.first_name || ''} ${u.last_name || ''}`.trim() }; });

    const { startIso, endIso } = yesterdayRange();
    if (!process.env.POSTMARK_SERVER_TOKEN) return { sent: 0, error: 'POSTMARK_SERVER_TOKEN not configured' };
    const { ServerClient } = await import('postmark');
    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
    const FROM = process.env.EMAIL_FROM || 'noreply@mypayprotec.com';

    let sent = 0; const detail = [];
    for (const pref of targets) {
        const u = uMap[pref.user_id];
        if (!u || !u.email) { detail.push({ user: pref.user_id, skipped: 'no email' }); continue; }

        const [{ data: pending }, { data: completed }] = await Promise.all([
            supabase.from('merchant_tasks')
                .select('id, title, priority, due_date, merchant_id, status')
                .eq('assigned_to', pref.user_id).eq('status', 'Pending')
                .order('due_date', { ascending: true, nullsFirst: false }).limit(200),
            supabase.from('merchant_tasks')
                .select('id, title, priority, due_date, merchant_id, status, completed_at')
                .eq('assigned_to', pref.user_id).eq('status', 'Completed')
                .gte('completed_at', startIso).lt('completed_at', endIso).limit(200)
        ]);
        const pend = pending || [], done = completed || [];

        // Merchant names for the listed tasks.
        const mids = [...new Set([...pend, ...done].map(t => t.merchant_id).filter(Boolean))];
        const mNames = {};
        if (mids.length) {
            const { data: ms } = await supabase.from('merchants').select('id, dba_name').in('id', mids);
            (ms || []).forEach(m => { mNames[m.id] = m.dba_name; });
        }

        // Recipients: the staff member + any manager copies (deduped, valid emails).
        const cc = [...new Set(pref.cc_user_ids || [])]
            .filter(id => id && id !== pref.user_id)
            .map(id => uMap[id]?.email).filter(Boolean);

        try {
            await client.sendEmail({
                From: FROM,
                To: u.email,
                Cc: cc.length ? cc.join(', ') : undefined,
                Subject: `Your tasks: ${pend.length} pending${done.length ? `, ${done.length} done yesterday` : ''}`,
                HtmlBody: buildHtml(u.name.split(' ')[0], pend, done, mNames),
                MessageStream: 'outbound'
            });
            sent++;
            detail.push({ user: pref.user_id, to: u.email, cc: cc.length, pending: pend.length, completed: done.length });
        } catch (e) {
            detail.push({ user: pref.user_id, error: e.message });
        }
    }

    await supabase.from('activity_logs').insert({
        email: trigger === 'cron' ? 'cron' : 'manual',
        action: `Task digest emails: ${sent} sent`, status: 'success',
        category: 'tasks', target_type: 'task_digest', severity: 'info',
        new_value: { sent, trigger }
    }).then(() => {}).catch(() => {});

    return { sent, detail };
}

// ── ADMIN API ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    const { data: actor } = await supabase.from('app_users').select('role, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const role = String(actor?.role || '').toLowerCase();
    const isAdmin = role.indexOf('super') !== -1 || role.indexOf('admin') !== -1;
    if (!isAdmin) return res.status(403).json({ success: false, message: 'Admins only.' });

    const { action } = req.body;

    try {
        if (action === 'get_config') {
            const [{ data: staff }, { data: prefs }, { data: hourRow }] = await Promise.all([
                supabase.from('app_users').select('userid, first_name, last_name, email').eq('is_active', true).order('first_name'),
                supabase.from('task_digest_prefs').select('*'),
                supabase.from('app_settings').select('value').eq('key', 'task_digest_hour_utc').maybeSingle()
            ]);
            const prefMap = {};
            (prefs || []).forEach(p => { prefMap[p.user_id] = { enabled: p.enabled, cc_user_ids: p.cc_user_ids || [] }; });
            return res.json({
                success: true,
                staff: (staff || []).map(u => ({ id: u.userid, name: `${u.first_name || ''} ${u.last_name || ''}`.trim(), email: u.email })),
                prefs: prefMap,
                send_hour: Number.isFinite(parseInt(hourRow?.value, 10)) ? parseInt(hourRow.value, 10) : DEFAULT_HOUR_UTC
            });
        }

        if (action === 'save_config') {
            const { hour, prefs } = req.body;
            const actorName = `${actor?.first_name || ''} ${actor?.last_name || ''}`.trim();
            if (Number.isFinite(+hour) && +hour >= 0 && +hour <= 23) {
                await supabase.from('app_settings').upsert({ key: 'task_digest_hour_utc', value: String(+hour), updated_at: new Date().toISOString(), updated_by: actorName }, { onConflict: 'key' });
            }
            const rows = (Array.isArray(prefs) ? prefs : []).map(p => ({
                user_id: String(p.user_id),
                enabled: !!p.enabled,
                cc_user_ids: Array.isArray(p.cc_user_ids) ? p.cc_user_ids.map(String) : [],
                updated_at: new Date().toISOString(), updated_by: actorName
            })).filter(r => r.user_id);
            if (rows.length) {
                const { error } = await supabase.from('task_digest_prefs').upsert(rows, { onConflict: 'user_id' });
                if (error) return res.json({ success: false, message: error.message });
            }
            return res.json({ success: true });
        }

        if (action === 'send_test') {
            const { user_id } = req.body;
            if (!user_id) return res.json({ success: false, message: 'user_id required' });
            const r = await sendTaskDigests({ force: true, onlyUser: user_id, trigger: 'manual' });
            return res.json({ success: true, data: r });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (e) {
        return res.json({ success: false, message: e.message });
    }
}
