import { createClient } from '@supabase/supabase-js';
import { ServerClient } from 'postmark';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body;

    try {
        if (action === 'send_risk_digest') {
            const { data: merchants, error } = await supabase
                .from('merchants')
                .select('merchant_id, dba_name, agent_id, volume_30_day, volume_90_day, last_batch_date')
                .eq('account_status', 'Approved')
                .gt('volume_90_day', 0);

            if (error) throw error;

            const atRisk = (merchants || [])
                .map(m => {
                    const baseline = parseFloat(m.volume_90_day) / 3;
                    const vol30 = parseFloat(m.volume_30_day);
                    return { ...m, baseline, drop_pct: Math.round((1 - vol30 / baseline) * 100) };
                })
                .filter(m => m.drop_pct >= 15)
                .sort((a, b) => b.drop_pct - a.drop_pct);

            if (atRisk.length === 0) {
                return res.status(200).json({ success: true, message: 'No at-risk merchants found.', at_risk_count: 0 });
            }

            const { data: admins } = await supabase.from('app_users')
                .select('email, first_name').in('role', ['super_admin', 'admin']).eq('is_active', true);

            if (!admins?.length) return res.status(200).json({ success: true, message: 'No admins to notify.', at_risk_count: atRisk.length });

            if (!process.env.POSTMARK_SERVER_TOKEN) {
                return res.status(200).json({ success: false, message: 'Email not configured.', at_risk_count: atRisk.length });
            }

            const fmt = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

            const tableRows = atRisk.slice(0, 25).map(m => `
                <tr>
                    <td style="padding:10px 14px; border-bottom:1px solid #f1f5f9; font-weight:600; color:#0a1628;">${m.dba_name}</td>
                    <td style="padding:10px 14px; border-bottom:1px solid #f1f5f9; font-family:monospace; color:#475569;">${m.merchant_id}</td>
                    <td style="padding:10px 14px; border-bottom:1px solid #f1f5f9;">${fmt(m.volume_30_day)}</td>
                    <td style="padding:10px 14px; border-bottom:1px solid #f1f5f9; color:#64748b;">${fmt(m.baseline)}</td>
                    <td style="padding:10px 14px; border-bottom:1px solid #f1f5f9;">
                        <span style="background:#fee2e2; color:#991b1b; font-weight:700; padding:3px 10px; border-radius:99px; font-size:12px;">-${m.drop_pct}%</span>
                    </td>
                </tr>`).join('');

            const emailHtml = `
<div style="font-family:'Inter',Arial,sans-serif; max-width:700px; margin:auto; padding:0; background:#f8fafc;">
    <div style="background:#004990; padding:28px 32px; border-radius:16px 16px 0 0;">
        <h1 style="color:white; margin:0; font-size:22px; font-weight:800;">At-Risk Merchant Digest</h1>
        <p style="color:rgba(255,255,255,0.75); margin:6px 0 0; font-size:14px;">${atRisk.length} merchant(s) with volume declining >15% vs 90-day average</p>
    </div>
    <div style="background:white; padding:28px 32px; border-radius:0 0 16px 16px; border:1px solid #e2e8f0; border-top:none;">
        <table style="width:100%; border-collapse:collapse; font-size:13px; color:#1e293b;">
            <thead>
                <tr style="background:#f8fafc;">
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">Merchant</th>
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">MID</th>
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">30-Day</th>
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">Expected</th>
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">Drop</th>
                </tr>
            </thead>
            <tbody>${tableRows}</tbody>
        </table>
        ${atRisk.length > 25 ? `<p style="margin-top:16px; font-size:12px; color:#94a3b8; text-align:center;">+ ${atRisk.length - 25} more merchants not shown. View full list in the admin dashboard.</p>` : ''}
        <hr style="border:0; border-top:1px solid #f1f5f9; margin:28px 0 20px;">
        <p style="font-size:11px; color:#94a3b8; text-align:center; margin:0;">PayProTec Operations · Automated Risk Alert · Do not reply</p>
    </div>
</div>`;

            const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
            let sent = 0;
            for (const admin of admins) {
                try {
                    await client.sendEmail({
                        From: process.env.EMAIL_FROM,
                        To: admin.email,
                        Subject: `At-Risk Alert: ${atRisk.length} merchant(s) need attention`,
                        HtmlBody: emailHtml,
                        TextBody: `${atRisk.length} at-risk merchants detected. Top 5: ${atRisk.slice(0,5).map(m=>`${m.dba_name} (-${m.drop_pct}%)`).join(', ')}`,
                        MessageStream: 'outbound'
                    });
                    sent++;
                } catch (e) { console.error('Email failed for', admin.email, e.message); }
            }

            await supabase.from('activity_logs').insert({
                email: 'system', action: 'at_risk_digest_sent',
                status: `${atRisk.length} at-risk, ${sent} notified`, category: 'alerts', severity: 'warning'
            });

            return res.status(200).json({ success: true, at_risk_count: atRisk.length, admins_notified: sent });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('Alerts Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
