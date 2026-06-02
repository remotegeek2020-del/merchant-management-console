import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { merchant_id, content_type, findings, submitted_by, merchant_name: merchantNameFromClient } = req.body;

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Resolve merchant name if client didn't supply it
    let merchant_name = merchantNameFromClient || '';
    if (!merchant_name && merchant_id) {
        const { data: mRow } = await supabase
            .from('merchants').select('dba_name').eq('id', merchant_id).maybeSingle();
        merchant_name = mRow?.dba_name || merchant_id;
    }

    // Load dev email list from site_settings
    const { data: settings } = await supabase
        .from('site_settings').select('key, value')
        .eq('key', 'web_developer_email');
    const devEmailRaw = settings?.[0]?.value?.trim() || '';
    const recipientEmails = devEmailRaw.split(',').map(e => e.trim()).filter(Boolean);

    if (!recipientEmails.length) {
        return res.status(200).json({ success: true, note: 'No dev recipients configured' });
    }

    const label = content_type === 'file' ? 'File Attachment' : 'Merchant Note';
    const findingsList = Array.isArray(findings) ? findings : [];
    const findingsHtml = findingsList.map(f => `<li style="margin-bottom:4px;">${f}</li>`).join('');
    const findingsText = findingsList.join(', ');

    const htmlBody = `
<div style="font-family:'Inter',Arial,sans-serif;max-width:560px;margin:auto;padding:32px;border:1px solid #e2e8f0;border-radius:16px;color:#1e293b;background:#fff;">
    <div style="font-size:22px;font-weight:800;color:#dc2626;margin-bottom:4px;">⚠️ Sensitive Data Alert</div>
    <div style="font-size:12px;color:#94a3b8;margin-bottom:20px;">${new Date().toLocaleString()} — JARVIS Detection</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
        <tr><td style="padding:8px 0;color:#64748b;font-weight:600;width:130px;">Submitted by</td><td style="padding:8px 0;font-weight:700;">${submitted_by || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;font-weight:600;">Merchant</td><td style="padding:8px 0;">${merchant_name || merchant_id || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;font-weight:600;">Content type</td><td style="padding:8px 0;">${label}</td></tr>
    </table>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;">
        <div style="font-size:11px;font-weight:800;color:#dc2626;text-transform:uppercase;margin-bottom:8px;">Detected Issues</div>
        <ul style="margin:0;padding-left:18px;font-size:14px;line-height:1.7;">${findingsHtml || '<li>Sensitive data pattern detected</li>'}</ul>
    </div>
    <div style="margin-top:16px;font-size:12px;color:#94a3b8;">The user was warned and chose to proceed. Please review the record in the merchant management console.</div>
</div>`;

    try {
        const { ServerClient } = await import('postmark');
        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
        await client.sendEmail({
            From: process.env.EMAIL_FROM,
            To: recipientEmails.join(','),
            Subject: `⚠️ Sensitive Data Alert — ${label} on ${merchant_name || merchant_id || 'Unknown Merchant'}`,
            HtmlBody: htmlBody,
            TextBody: `Sensitive Data Alert\n\nSubmitted by: ${submitted_by}\nMerchant: ${merchant_name || merchant_id}\nContent type: ${label}\nDetected: ${findingsText}\n\nThe user was warned and chose to proceed.`,
            MessageStream: 'outbound'
        });
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[Sensitive Data Alert Error]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
