import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
    const { description, page_url, reporter_name, reporter_email, screenshot_path } = req.body;
    if (!description) return res.status(400).json({ success: false, message: 'Description required' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Get web developer email from site_settings
    const { data: settingRow } = await supabase
        .from('site_settings').select('value').eq('key', 'web_developer_email').single();
    const devEmail = settingRow?.value?.trim();
    if (!devEmail) return res.status(200).json({ success: true, note: 'No web developer email configured — report not emailed.' });

    try {
        const { ServerClient } = await import('postmark');
        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);

        const screenshotHtml = screenshot_path
            ? `<div style="margin-top:20px;"><strong>Screenshot:</strong><br><img src="https://zuzwljjrppyrzngmhdru.supabase.co/storage/v1/object/public/bug-reports/${screenshot_path}" style="max-width:100%;border-radius:8px;border:1px solid #e2e8f0;margin-top:8px;"/></div>`
            : '';

        await client.sendEmail({
            From: process.env.EMAIL_FROM,
            To: devEmail,
            Subject: `🐛 Bug Report from ${reporter_name || reporter_email || 'Unknown User'}`,
            HtmlBody: `
                <div style="font-family:'Inter',Arial,sans-serif;max-width:560px;margin:auto;padding:32px;border:1px solid #e2e8f0;border-radius:16px;color:#1e293b;background:#fff;">
                    <div style="font-size:22px;font-weight:800;color:#dc2626;margin-bottom:4px;">🐛 Bug Report</div>
                    <div style="font-size:12px;color:#94a3b8;margin-bottom:20px;">${new Date().toLocaleString()}</div>
                    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
                        <tr><td style="padding:8px 0;color:#64748b;font-weight:600;width:130px;">Reported by</td><td style="padding:8px 0;font-weight:700;">${reporter_name || '—'}</td></tr>
                        <tr><td style="padding:8px 0;color:#64748b;font-weight:600;">Email</td><td style="padding:8px 0;">${reporter_email || '—'}</td></tr>
                        <tr><td style="padding:8px 0;color:#64748b;font-weight:600;">Page</td><td style="padding:8px 0;font-family:monospace;font-size:11px;">${page_url || '—'}</td></tr>
                    </table>
                    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;">
                        <div style="font-size:11px;font-weight:800;color:#dc2626;text-transform:uppercase;margin-bottom:8px;">Bug Description</div>
                        <div style="font-size:14px;line-height:1.7;white-space:pre-wrap;">${description}</div>
                    </div>
                    ${screenshotHtml}
                </div>`,
            TextBody: `Bug Report\n\nFrom: ${reporter_name} (${reporter_email})\nPage: ${page_url}\n\n${description}`,
            MessageStream: 'outbound'
        });

        return res.status(200).json({ success: true });
    } catch (e) {
        console.error('[Bug Report Email Error]', e.message);
        return res.status(500).json({ success: false, message: e.message });
    }
}
