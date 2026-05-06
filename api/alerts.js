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
                .select('merchant_id, dba_name, agent_id, agent_name, volume_30_day, volume_90_day, last_batch_date')
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

            // Group at-risk merchants by agent_id
            const byAgent = {};
            for (const m of atRisk) {
                if (!m.agent_id) continue;
                if (!byAgent[m.agent_id]) byAgent[m.agent_id] = [];
                byAgent[m.agent_id].push(m);
            }

            const uniqueAgentIds = Object.keys(byAgent);
            if (!uniqueAgentIds.length) {
                return res.status(200).json({ success: true, message: 'No agents linked to at-risk merchants.', at_risk_count: atRisk.length });
            }

            // Resolve agent_id strings → partner persons via agent_identifiers → agents → persons
            const { data: agentRows } = await supabase
                .from('agent_identifiers')
                .select('id_string, agents!agent_identifiers_agent_id_fkey(agent_name, persons!agents_parent_agent_id_fkey(full_name, email))')
                .in('id_string', uniqueAgentIds);

            // Build map: agent_id_string → { partner_name, partner_email }
            const agentMap = {};
            for (const row of (agentRows || [])) {
                if (row.agents?.persons?.email) {
                    agentMap[row.id_string] = {
                        partner_name: row.agents.persons.full_name || row.agents.agent_name || 'Partner',
                        partner_email: row.agents.persons.email
                    };
                }
            }

            if (!process.env.POSTMARK_SERVER_TOKEN) {
                return res.status(200).json({ success: false, message: 'Email not configured.', at_risk_count: atRisk.length });
            }

            const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
            const fmt = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
            let sent = 0;

            for (const agentId of uniqueAgentIds) {
                const partner = agentMap[agentId];
                if (!partner) continue;

                const partnerMerchants = byAgent[agentId];
                const tableRows = partnerMerchants.map(m => `
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
        <h1 style="color:white; margin:0; font-size:22px; font-weight:800;">Volume Alert – Action Required</h1>
        <p style="color:rgba(255,255,255,0.75); margin:6px 0 0; font-size:14px;">
            Hi ${partner.partner_name}, ${partnerMerchants.length} of your merchant(s) show a significant volume drop.
        </p>
    </div>
    <div style="background:white; padding:28px 32px; border-radius:0 0 16px 16px; border:1px solid #e2e8f0; border-top:none;">
        <table style="width:100%; border-collapse:collapse; font-size:13px; color:#1e293b;">
            <thead>
                <tr style="background:#f8fafc;">
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">Merchant</th>
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">MID</th>
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">30-Day Vol</th>
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">Expected</th>
                    <th style="padding:10px 14px; text-align:left; font-size:10px; color:#94a3b8; text-transform:uppercase; letter-spacing:0.6px; font-weight:700;">Drop</th>
                </tr>
            </thead>
            <tbody>${tableRows}</tbody>
        </table>
        <p style="margin-top:20px; font-size:13px; color:#475569; line-height:1.6;">
            Please review these accounts and reach out to help your merchants stay active and processing.
            If you need assistance, contact your PayProTec support representative.
        </p>
        <hr style="border:0; border-top:1px solid #f1f5f9; margin:24px 0 16px;">
        <p style="font-size:11px; color:#94a3b8; text-align:center; margin:0;">PayProTec Operations · Automated Partner Alert · Do not reply</p>
    </div>
</div>`;

                try {
                    await client.sendEmail({
                        From: process.env.EMAIL_FROM,
                        To: partner.partner_email,
                        Subject: `Volume Alert: ${partnerMerchants.length} merchant(s) need your attention`,
                        HtmlBody: emailHtml,
                        TextBody: `Hi ${partner.partner_name}, ${partnerMerchants.length} of your merchants have significant volume drops: ${partnerMerchants.map(m=>`${m.dba_name} (-${m.drop_pct}%)`).join(', ')}.`,
                        MessageStream: 'outbound'
                    });
                    sent++;
                } catch (e) { console.error('Email failed for partner', partner.partner_email, e.message); }
            }

            await supabase.from('activity_logs').insert({
                email: 'system', action: 'at_risk_partner_digest_sent',
                status: `${atRisk.length} at-risk merchants, ${sent} partner(s) notified`,
                category: 'alerts', severity: 'warning'
            });

            return res.status(200).json({ success: true, at_risk_count: atRisk.length, admins_notified: sent });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('Alerts Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
