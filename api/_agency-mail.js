// Per-agency (white-label) transactional email sender.
// An agency can configure its own provider so magic-link / invite emails go out
// from THEIR domain, not PayProTec's. Config is stored encrypted in app_config
// under key `agency_email:<portal_id>` (secrets included, whole blob encrypted).
import { getConfigValue, setConfigValue } from './api-config.js';

export const AGENCY_MAIL_PROVIDERS = ['postmark', 'sendgrid', 'mailgun', 'smtp'];
function cfgKey(portalId) { return 'agency_email:' + portalId; }

export async function getAgencyEmailConfig(portalId) {
    if (!portalId) return null;
    try { const raw = await getConfigValue(cfgKey(portalId)); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
export async function saveAgencyEmailConfig(portalId, config, updatedBy) {
    await setConfigValue(cfgKey(portalId), JSON.stringify(config || {}), updatedBy || 'agency');
}
// Never send secrets to the client — return a masked view + which fields are set.
export function maskAgencyEmailConfig(c) {
    if (!c) return { enabled: false, provider: null };
    const has = v => !!(v && String(v).length);
    return {
        enabled: !!c.enabled, provider: c.provider || null,
        from_email: c.from_email || '', from_name: c.from_name || '',
        mailgun_domain: c.mailgun_domain || '', mailgun_region: c.mailgun_region || 'us',
        smtp_host: c.smtp_host || '', smtp_port: c.smtp_port || 587, smtp_user: c.smtp_user || '', smtp_secure: !!c.smtp_secure,
        postmark_token_set: has(c.postmark_token), sendgrid_key_set: has(c.sendgrid_key),
        mailgun_key_set: has(c.mailgun_key), smtp_pass_set: has(c.smtp_pass)
    };
}

// Send via the agency's configured provider. Returns { sent, configured, provider, error }.
export async function sendAgencyEmail(portalId, { to, subject, html, text }) {
    const c = await getAgencyEmailConfig(portalId);
    if (!c || !c.enabled || !c.provider || !c.from_email) return { sent: false, configured: false };
    const fromName = c.from_name || '';
    const fromHeader = fromName ? `${fromName} <${c.from_email}>` : c.from_email;
    try {
        if (c.provider === 'postmark') {
            if (!c.postmark_token) return { sent: false, configured: true, error: 'Missing Postmark token' };
            const { ServerClient } = await import('postmark');
            const client = new ServerClient(c.postmark_token);
            await client.sendEmail({ From: fromHeader, To: to, Subject: subject, HtmlBody: html, TextBody: text || '', MessageStream: 'outbound' });
            return { sent: true, configured: true, provider: 'postmark' };
        }
        if (c.provider === 'sendgrid') {
            if (!c.sendgrid_key) return { sent: false, configured: true, error: 'Missing SendGrid key' };
            const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
                method: 'POST', headers: { Authorization: 'Bearer ' + c.sendgrid_key, 'Content-Type': 'application/json' },
                body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: c.from_email, name: fromName || undefined }, subject, content: [{ type: 'text/plain', value: text || ' ' }, { type: 'text/html', value: html }] })
            });
            if (r.status === 202) return { sent: true, configured: true, provider: 'sendgrid' };
            let msg = 'SendGrid error ' + r.status; try { const j = await r.json(); msg = (j.errors && j.errors[0] && j.errors[0].message) || msg; } catch (e) {}
            return { sent: false, configured: true, error: msg };
        }
        if (c.provider === 'mailgun') {
            if (!c.mailgun_key || !c.mailgun_domain) return { sent: false, configured: true, error: 'Missing Mailgun key/domain' };
            const base = (c.mailgun_region === 'eu') ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
            const form = new URLSearchParams({ from: fromHeader, to, subject, text: text || ' ', html });
            const r = await fetch(`${base}/v3/${c.mailgun_domain}/messages`, {
                method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from('api:' + c.mailgun_key).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString()
            });
            if (r.ok) return { sent: true, configured: true, provider: 'mailgun' };
            let msg = 'Mailgun error ' + r.status; try { const j = await r.json(); msg = j.message || msg; } catch (e) {}
            return { sent: false, configured: true, error: msg };
        }
        if (c.provider === 'smtp') {
            if (!c.smtp_host || !c.smtp_user) return { sent: false, configured: true, error: 'Missing SMTP host/user' };
            const nodemailer = (await import('nodemailer')).default;
            const port = parseInt(c.smtp_port, 10) || 587;
            const transport = nodemailer.createTransport({ host: c.smtp_host, port, secure: !!c.smtp_secure || port === 465, auth: { user: c.smtp_user, pass: c.smtp_pass } });
            await transport.sendMail({ from: fromHeader, to, subject, text: text || '', html });
            return { sent: true, configured: true, provider: 'smtp' };
        }
        return { sent: false, configured: true, error: 'Unknown provider' };
    } catch (e) {
        return { sent: false, configured: true, error: (e && e.message) || 'Send failed' };
    }
}
