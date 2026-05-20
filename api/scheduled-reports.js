import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { ServerClient } from 'postmark';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── EMAIL BUILDER ────────────────────────────────────────────────────────────

function buildReportEmail(data) {
    const { date, totalMerchants, approvedMerchants, totalVolume30d, totalVolume90d,
            newMerchantsYesterday, topPartners, statusBreakdown } = data;

    const fmt = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
    const pct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—';

    const topPartnersRows = (topPartners || []).slice(0, 10).map((p, i) => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:8px 12px; font-weight:700; color:#94a3b8; font-size:12px;">${i + 1}</td>
            <td style="padding:8px 12px; font-weight:700; color:#002d5a; font-size:13px;">${p.name}</td>
            <td style="padding:8px 12px; color:#334155; font-size:12px; text-align:right;">${p.merchant_count} merchants</td>
            <td style="padding:8px 12px; font-weight:700; color:#004990; font-size:12px; text-align:right;">${fmt(p.volume_30_day)}</td>
        </tr>`).join('');

    const statusRows = Object.entries(statusBreakdown || {}).map(([status, count]) => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:7px 12px; color:#334155; font-size:12px;">${status}</td>
            <td style="padding:7px 12px; font-weight:700; color:#002d5a; font-size:12px; text-align:right;">${count.toLocaleString()}</td>
            <td style="padding:7px 12px; color:#64748b; font-size:11px; text-align:right;">${pct(count, totalMerchants)}</td>
        </tr>`).join('');

    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:640px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#004990 0%,#0369a1 100%);padding:32px 40px;">
        <div style="color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Daily Partner Report</div>
        <div style="color:white;font-size:24px;font-weight:800;letter-spacing:-0.5px;">Portfolio Snapshot</div>
        <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px;">${date}</div>
    </div>

    <!-- KPI Row -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;border-bottom:1px solid #e2e8f0;">
        <div style="padding:20px 24px;border-right:1px solid #e2e8f0;">
            <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Total Merchants</div>
            <div style="font-size:22px;font-weight:800;color:#002d5a;">${totalMerchants.toLocaleString()}</div>
            <div style="font-size:11px;color:#16a34a;font-weight:600;margin-top:2px;">${approvedMerchants.toLocaleString()} approved</div>
        </div>
        <div style="padding:20px 24px;border-right:1px solid #e2e8f0;">
            <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">30-Day Volume</div>
            <div style="font-size:22px;font-weight:800;color:#002d5a;">${fmt(totalVolume30d)}</div>
        </div>
        <div style="padding:20px 24px;">
            <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">New Yesterday</div>
            <div style="font-size:22px;font-weight:800;color:#002d5a;">${newMerchantsYesterday}</div>
            <div style="font-size:11px;color:#64748b;font-weight:600;margin-top:2px;">new enrollments</div>
        </div>
    </div>

    <!-- Top Partners -->
    <div style="padding:24px 32px 0;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:12px;">Top Partners — 30-Day Volume</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead>
                <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">#</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Partner</th>
                    <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Merchants</th>
                    <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">30D Volume</th>
                </tr>
            </thead>
            <tbody>${topPartnersRows || '<tr><td colspan="4" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No data available</td></tr>'}</tbody>
        </table>
    </div>

    <!-- Status Breakdown -->
    <div style="padding:24px 32px;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:12px;">Merchant Status Breakdown</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead>
                <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                    <th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Status</th>
                    <th style="padding:7px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Count</th>
                    <th style="padding:7px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">% of Total</th>
                </tr>
            </thead>
            <tbody>${statusRows}</tbody>
        </table>
    </div>

    <!-- Footer -->
    <div style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;">
        <div style="font-size:11px;color:#94a3b8;text-align:center;">
            This is an automated daily report from your Partner Management Console.<br>
            To unsubscribe, contact your super admin.
        </div>
    </div>
</div>
</body>
</html>`;
}

// ── REPORT DATA BUILDER ──────────────────────────────────────────────────────

async function buildReportData() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yyyymmdd = d => d.toISOString().split('T')[0];

    const [merchantsRes, leaderboardRes, newMerchantsRes] = await Promise.all([
        supabase.from('merchants').select('account_status, volume_30_day, volume_90_day', { count: 'exact' }),
        supabase.from('partner_leaderboard_mv').select('name, merchant_count, volume_30_day, volume_90_day').order('volume_30_day', { ascending: false }).limit(10),
        supabase.from('merchants').select('id', { count: 'exact' }).gte('enrollment_date', yyyymmdd(yesterday)).lt('enrollment_date', yyyymmdd(today))
    ]);

    const allMerchants = merchantsRes.data || [];
    const totalMerchants = merchantsRes.count || 0;
    const approvedMerchants = allMerchants.filter(m => m.account_status === 'Approved').length;
    const totalVolume30d = allMerchants.reduce((s, m) => s + parseFloat(m.volume_30_day || 0), 0);
    const totalVolume90d = allMerchants.reduce((s, m) => s + parseFloat(m.volume_90_day || 0), 0);

    const statusBreakdown = {};
    allMerchants.forEach(m => {
        const s = m.account_status || 'Unknown';
        statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;
    });
    // Sort by count descending
    const sortedBreakdown = Object.fromEntries(
        Object.entries(statusBreakdown).sort(([, a], [, b]) => b - a)
    );

    const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    return {
        date: dateStr,
        totalMerchants,
        approvedMerchants,
        totalVolume30d,
        totalVolume90d,
        newMerchantsYesterday: newMerchantsRes.count || 0,
        topPartners: leaderboardRes.data || [],
        statusBreakdown: sortedBreakdown
    };
}

// ── SEND TO ALL RECIPIENTS ───────────────────────────────────────────────────

export async function sendDailyReport(trigger = 'cron') {
    const { data: recipients, error } = await supabase.from('report_recipients').select('email, name');
    if (error) throw error;
    if (!recipients || recipients.length === 0) return { sent: 0, skipped: 'no recipients' };

    const reportData = await buildReportData();
    const html = buildReportEmail(reportData);
    const subject = `📊 Daily Partner Report — ${reportData.date}`;

    if (!process.env.POSTMARK_SERVER_TOKEN) throw new Error('POSTMARK_SERVER_TOKEN not configured');
    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);

    let sent = 0;
    const errors = [];
    for (const r of recipients) {
        try {
            await client.sendEmail({
                From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
                To: r.email,
                Subject: subject,
                HtmlBody: html,
                MessageStream: 'outbound'
            });
            sent++;
        } catch (e) {
            errors.push(`${r.email}: ${e.message}`);
        }
    }

    await supabase.from('report_send_log').insert({
        trigger,
        recipient_count: sent,
        status: errors.length > 0 ? (sent > 0 ? 'partial' : 'failed') : 'sent',
        error_message: errors.length > 0 ? errors.join('; ') : null
    });

    return { sent, total: recipients.length, errors };
}

// ── HTTP HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    res.setHeader('Content-Type', 'application/json');
    const { action, email, name, id } = req.body;

    try {
        if (action === 'get_recipients') {
            const { data, error } = await supabase.from('report_recipients').select('*').order('created_at', { ascending: true });
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'add_recipient') {
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ success: false, message: 'Invalid email address' });
            }
            const { error } = await supabase.from('report_recipients').insert({ email: email.toLowerCase().trim(), name: name || null });
            if (error) {
                if (error.code === '23505') return res.status(409).json({ success: false, message: 'Email already exists' });
                throw error;
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'remove_recipient') {
            const { error } = await supabase.from('report_recipients').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'send_now') {
            const result = await sendDailyReport('manual');
            return res.status(200).json({ success: true, ...result });
        }

        if (action === 'get_log') {
            const { data, error } = await supabase.from('report_send_log').select('*').order('sent_at', { ascending: false }).limit(20);
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('Scheduled Reports Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
