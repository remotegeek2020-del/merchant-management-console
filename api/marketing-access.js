// ── Marketing → Settings access gate ────────────────────────────────────────
// check           : does the current staff user have Marketing Settings access?
// request_permission : send a permission request to the web developers (the
//                   web_developer_email configured in Secret Dungeon) + log it.
import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';
import { loadActor, actorName, canMarketingSettings } from './_access.js';
import { logActivity } from './_activity.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ok = (res, data) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    try {
        const session = await validateSession(req);
        if (!session) return bad(res, 'Unauthorized', 401);
        const actor = await loadActor(session.userid);
        if (!actor) return bad(res, 'Unauthorized', 401);
        const body = req.method === 'GET' ? (req.query || {}) : (req.body || {});
        const action = body.action || 'check';

        if (action === 'check') {
            return ok(res, {
                access: canMarketingSettings(actor),
                role: actor.role || null,
                name: actorName(actor),
                email: actor.email || null
            });
        }

        if (action === 'request_permission') {
            const who = actorName(actor);
            const area = String(body.area || 'Marketing → Settings').slice(0, 120);
            const reason = String(body.reason || '').slice(0, 1000);

            // Recipients = web developer email(s) configured in Secret Dungeon.
            const { data: setting } = await supabase.from('site_settings')
                .select('value').eq('key', 'web_developer_email').maybeSingle();
            const recipients = String(setting?.value || '').split(',').map(s => s.trim()).filter(Boolean);

            // Always record the request in the activity log (audit trail).
            logActivity({
                email: actor.email || session.userid,
                action: `Permission requested by ${who} for ${area}` + (reason ? ` — "${reason}"` : ''),
                category: 'security', status: 'pending', severity: 'warning',
                target_type: 'access_request', target_id: 'access_marketing_settings',
                new_value: { area, reason, requested_by: who, email: actor.email }
            }, req);

            let emailed = false;
            if (recipients.length && process.env.POSTMARK_SERVER_TOKEN && process.env.EMAIL_FROM) {
                try {
                    const { ServerClient } = await import('postmark');
                    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                    const htmlBody = `
                        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:28px;border:1px solid #e2e8f0;border-radius:14px;color:#1e293b;">
                          <div style="font-size:20px;font-weight:800;color:#2563eb;margin-bottom:4px;">🔐 Access Request</div>
                          <div style="font-size:12px;color:#94a3b8;margin-bottom:18px;">${new Date().toLocaleString()}</div>
                          <table style="width:100%;border-collapse:collapse;font-size:13px;">
                            <tr><td style="padding:7px 0;color:#64748b;font-weight:600;width:120px;">Requested by</td><td style="padding:7px 0;font-weight:700;">${who}</td></tr>
                            <tr><td style="padding:7px 0;color:#64748b;font-weight:600;">Email</td><td style="padding:7px 0;">${actor.email || '—'}</td></tr>
                            <tr><td style="padding:7px 0;color:#64748b;font-weight:600;">Area</td><td style="padding:7px 0;">${area}</td></tr>
                          </table>
                          ${reason ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-top:12px;"><div style="font-size:11px;font-weight:800;color:#2563eb;text-transform:uppercase;margin-bottom:6px;">Reason</div><div style="font-size:14px;line-height:1.6;white-space:pre-wrap;">${reason}</div></div>` : ''}
                          <div style="font-size:12px;color:#64748b;margin-top:16px;">Grant this in <b>User Management</b> → the user → <b>Marketing Settings</b> toggle.</div>
                        </div>`;
                    await client.sendEmail({
                        From: process.env.EMAIL_FROM,
                        To: recipients.join(','),
                        Subject: `🔐 Access request: ${who} → ${area}`,
                        HtmlBody: htmlBody,
                        TextBody: `Access request\n\nFrom: ${who} (${actor.email || '—'})\nArea: ${area}\n${reason ? '\nReason: ' + reason : ''}\n\nGrant in User Management → Marketing Settings toggle.`,
                        MessageStream: 'outbound'
                    });
                    emailed = true;
                } catch (e) { /* logged already; email best-effort */ }
            }
            return ok(res, { sent: emailed, recipients: recipients.length, note: recipients.length ? null : 'No web developer email configured in Secret Dungeon — request was logged only.' });
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
