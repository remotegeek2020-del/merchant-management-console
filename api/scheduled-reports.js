import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { ServerClient } from 'postmark';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ── FORMATTERS ───────────────────────────────────────────────────────────────

const fmt = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0);
const num = n => Number(n || 0).toLocaleString();
const pct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) + '%' : '—';
const dtFmt = s => s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

// ── PARTNERS & MERCHANTS EMAIL ───────────────────────────────────────────────

function buildPartnersEmail(data) {
    const {
        date, totalMerchants, approvedMerchants, totalVolume30d, totalVolume90d,
        newMerchantsYesterday, newMerchantsThisWeek, approvedThisWeek,
        newAgentsThisWeek, topPartners, topSubmittingPartners, statusBreakdown,
        newMerchantsDetail
    } = data;

    const topPartnersRows = (topPartners || []).slice(0, 10).map((p, i) => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:8px 12px;font-weight:700;color:#94a3b8;font-size:12px;">${i + 1}</td>
            <td style="padding:8px 12px;font-weight:700;color:#002d5a;font-size:13px;">${p.name}</td>
            <td style="padding:8px 12px;color:#334155;font-size:12px;text-align:right;">${num(p.merchant_count)}</td>
            <td style="padding:8px 12px;font-weight:700;color:#004990;font-size:12px;text-align:right;">${fmt(p.volume_30_day)}</td>
        </tr>`).join('');

    const weeklyPartnerRows = (topSubmittingPartners || []).slice(0, 10).map((p, i) => {
        const rate = p.submitted > 0 ? Math.round((p.approved / p.submitted) * 100) : 0;
        const rateColor = rate >= 75 ? '#16a34a' : rate >= 50 ? '#d97706' : '#dc2626';
        return `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:8px 12px;font-weight:700;color:#94a3b8;font-size:12px;">${i + 1}</td>
            <td style="padding:8px 12px;font-weight:700;color:#002d5a;font-size:13px;">${p.agent_name}</td>
            <td style="padding:8px 12px;color:#334155;font-size:12px;text-align:right;">${num(p.submitted)}</td>
            <td style="padding:8px 12px;color:#16a34a;font-weight:700;font-size:12px;text-align:right;">${num(p.approved)}</td>
            <td style="padding:8px 12px;font-weight:700;font-size:12px;text-align:right;color:${rateColor};">${rate}%</td>
        </tr>`;
    }).join('');

    const newMerchantDetailRows = (newMerchantsDetail || []).map(m => {
        const statusColor = m.account_status === 'Approved' ? '#16a34a' : m.account_status === 'Pipeline' ? '#0369a1' : '#94a3b8';
        return `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:7px 12px;font-size:12px;font-weight:600;color:#002d5a;">${m.dba_name || '—'}</td>
            <td style="padding:7px 12px;font-size:11px;font-family:monospace;color:#0369a1;">${m.merchant_id || '—'}</td>
            <td style="padding:7px 12px;font-size:11px;color:#475569;">${m.agent_name || '—'}</td>
            <td style="padding:7px 12px;font-size:11px;font-weight:700;color:${statusColor};">${m.account_status || '—'}</td>
            <td style="padding:7px 12px;font-size:11px;color:#94a3b8;">${dtFmt(m.enrollment_date)}</td>
        </tr>`;
    }).join('');

    const statusRows = Object.entries(statusBreakdown || {}).map(([status, count]) => {
        const isActive = status === 'Approved';
        return `
        <tr style="border-bottom:1px solid #f1f5f9;${isActive ? 'background:#f0fdf4;' : ''}">
            <td style="padding:7px 12px;color:#334155;font-size:12px;${isActive ? 'font-weight:700;' : ''}">${status}</td>
            <td style="padding:7px 12px;font-weight:700;color:#002d5a;font-size:12px;text-align:right;">${Number(count).toLocaleString()}</td>
            <td style="padding:7px 12px;color:#64748b;font-size:11px;text-align:right;">${pct(count, totalMerchants)}</td>
        </tr>`;
    }).join('');

    return `<!DOCTYPE html><html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:680px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <div style="background:linear-gradient(135deg,#004990 0%,#0369a1 100%);padding:32px 40px;">
        <div style="color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Partners &amp; Merchants Report</div>
        <div style="color:white;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Portfolio Snapshot</div>
        <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px;">${date}</div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:0;border-bottom:1px solid #e2e8f0;">
        <div style="padding:18px 16px;border-right:1px solid #e2e8f0;">
            <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Total Merchants</div>
            <div style="font-size:20px;font-weight:800;color:#002d5a;">${num(totalMerchants)}</div>
            <div style="font-size:11px;color:#16a34a;font-weight:600;margin-top:2px;">${num(approvedMerchants)} approved</div>
        </div>
        <div style="padding:18px 16px;border-right:1px solid #e2e8f0;">
            <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">30-Day Volume</div>
            <div style="font-size:20px;font-weight:800;color:#002d5a;">${fmt(totalVolume30d)}</div>
            <div style="font-size:11px;color:#64748b;font-weight:600;margin-top:2px;">90d: ${fmt(totalVolume90d)}</div>
        </div>
        <div style="padding:18px 16px;border-right:1px solid #e2e8f0;">
            <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">This Week</div>
            <div style="font-size:20px;font-weight:800;color:#002d5a;">${num(newMerchantsThisWeek)}</div>
            <div style="font-size:11px;color:#16a34a;font-weight:600;margin-top:2px;">${num(approvedThisWeek)} approved</div>
        </div>
        <div style="padding:18px 16px;">
            <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">New Yesterday</div>
            <div style="font-size:20px;font-weight:800;color:#002d5a;">${num(newMerchantsYesterday)}</div>
            <div style="font-size:11px;color:#64748b;font-weight:600;margin-top:2px;">enrollments</div>
        </div>
    </div>

    <div style="background:#eff6ff;border-bottom:1px solid #dbeafe;padding:14px 32px;display:flex;align-items:center;gap:12px;">
        <div style="background:#004990;color:white;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;flex-shrink:0;">${num(newAgentsThisWeek)}</div>
        <div>
            <div style="font-size:13px;font-weight:800;color:#002d5a;">New Agent IDs Approved This Week</div>
            <div style="font-size:11px;color:#3b82f6;margin-top:1px;">New partner agent identifiers added to the system in the last 7 days</div>
        </div>
    </div>

    <div style="padding:24px 32px 0;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:4px;">Partner Activity This Week — Merchant Submissions</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">Partners who enrolled the most merchants since Monday (live data)</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">#</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Partner</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Submitted</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Approved</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Rate</th>
            </tr></thead>
            <tbody>${weeklyPartnerRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No submissions this week</td></tr>'}</tbody>
        </table>
    </div>

    ${(newMerchantsDetail || []).length > 0 ? `
    <div style="padding:20px 32px 0;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:4px;">🏪 New Merchants This Week (${(newMerchantsDetail || []).length})</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">Merchants enrolled since Monday — most recent first</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                <th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">DBA Name</th>
                <th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">MID</th>
                <th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Agent</th>
                <th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Status</th>
                <th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Enrolled</th>
            </tr></thead>
            <tbody>${newMerchantDetailRows}</tbody>
        </table>
    </div>` : ''}

    <div style="padding:24px 32px 0;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:4px;">Top Partners — 30-Day Volume</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">Overall leaderboard by rolling 30-day processing volume</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">#</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Partner</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Merchants</th>
                <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">30D Volume</th>
            </tr></thead>
            <tbody>${topPartnersRows || '<tr><td colspan="4" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No data available</td></tr>'}</tbody>
        </table>
    </div>

    <div style="padding:24px 32px;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:4px;">Merchant Status Breakdown</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">Full portfolio distribution across all account statuses</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                <th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Status</th>
                <th style="padding:7px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Count</th>
                <th style="padding:7px 12px;text-align:right;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">% of Total</th>
            </tr></thead>
            <tbody>${statusRows}</tbody>
        </table>
    </div>

    <div style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;">
        <div style="font-size:11px;color:#94a3b8;text-align:center;">Automated report from your Partner Management Console. To unsubscribe, contact your super admin.</div>
    </div>
</div></body></html>`;
}

// ── OPS EMAIL (INVENTORY / DEPLOYMENTS / RETURNS) ────────────────────────────

function buildOpsEmail(data) {
    const { date, inventory, deployments, returns } = data;
    const inv = inventory || {};
    const dep = deployments || {};
    const ret = returns || {};
    const yday = data.yesterday || { label: '', deployments: [] };

    const ydayRows = (yday.deployments || []).map(d => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${d.deployment_id || '—'}</td>
            <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#002d5a;">${d.dba_name || '—'}<br><span style="font-size:10px;font-family:monospace;color:#64748b;font-weight:400;">MID: ${d.merchant_id || '—'}</span></td>
            <td style="padding:8px 12px;font-size:11px;color:#334155;">${d.terminal_type || '—'}</td>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${d.purchase_type || '—'}</td>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${d.tracking_id || '—'}</td>
        </tr>`).join('');

    const ydayRetRows = (yday.returns || []).map(r => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${r.return_id || '—'}</td>
            <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#002d5a;">${r.dba_name || '—'}<br><span style="font-size:10px;font-family:monospace;color:#64748b;font-weight:400;">MID: ${r.merchant_id || '—'}</span></td>
            <td style="padding:8px 12px;font-size:11px;color:#334155;">${r.terminal_type || '—'}</td>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${r.return_reason || '—'}</td>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${r.destination || '—'}</td>
        </tr>`).join('');

    const statusDot = s => {
        const c = s === 'Open' ? '#dc2626' : s === 'Closed' ? '#16a34a' : '#64748b';
        return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:6px;"></span>`;
    };

    const depRows = (dep.recent || []).map(d => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${d.deployment_id || '—'}</td>
            <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#002d5a;">${d.dba_name || '—'}<br><span style="font-size:10px;font-family:monospace;color:#64748b;font-weight:400;">MID: ${d.merchant_id || '—'}</span></td>
            <td style="padding:8px 12px;font-size:11px;color:#334155;">${d.terminal_type || '—'}</td>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${d.purchase_type || '—'}</td>
            <td style="padding:8px 12px;font-size:11px;">${statusDot(d.status)}${d.status}</td>
        </tr>`).join('');

    const retRows = (ret.recent || []).map(r => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${r.return_id || '—'}</td>
            <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#002d5a;">${r.dba_name || '—'}<br><span style="font-size:10px;font-family:monospace;color:#64748b;font-weight:400;">MID: ${r.merchant_id || '—'}</span></td>
            <td style="padding:8px 12px;font-size:11px;color:#334155;">${r.terminal_type || '—'}</td>
            <td style="padding:8px 12px;font-size:11px;color:#64748b;">${r.return_reason || '—'}</td>
            <td style="padding:8px 12px;font-size:11px;">${statusDot(r.status)}${r.status}</td>
        </tr>`).join('');

    const termBreakdown = Object.entries(inv.terminal_breakdown || {}).slice(0, 8).map(([t, c]) => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:6px 12px;font-size:12px;color:#334155;">${t}</td>
            <td style="padding:6px 12px;font-size:12px;font-weight:700;color:#002d5a;text-align:right;">${num(c)}</td>
        </tr>`).join('');

    return `<!DOCTYPE html><html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:680px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <div style="background:linear-gradient(135deg,#0d9488 0%,#0891b2 100%);padding:32px 40px;">
        <div style="color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Operations Report</div>
        <div style="color:white;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Inventory · Deployments · Returns</div>
        <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px;">${date}</div>
    </div>

    <!-- Inventory KPIs -->
    <div style="padding:20px 32px 0;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:12px;">📦 Inventory Overview</div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <div style="padding:14px 10px;text-align:center;border-right:1px solid #e2e8f0;">
                <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">Total</div>
                <div style="font-size:20px;font-weight:800;color:#002d5a;">${num(inv.total)}</div>
            </div>
            <div style="padding:14px 10px;text-align:center;border-right:1px solid #e2e8f0;background:#f0fdf4;">
                <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">Stocked</div>
                <div style="font-size:20px;font-weight:800;color:#16a34a;">${num(inv.stocked)}</div>
            </div>
            <div style="padding:14px 10px;text-align:center;border-right:1px solid #e2e8f0;">
                <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">Deployed</div>
                <div style="font-size:20px;font-weight:800;color:#0369a1;">${num(inv.deployed)}</div>
            </div>
            <div style="padding:14px 10px;text-align:center;border-right:1px solid #e2e8f0;background:#fefce8;">
                <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">Repairing</div>
                <div style="font-size:20px;font-weight:800;color:#d97706;">${num(inv.repairing)}</div>
            </div>
            <div style="padding:14px 10px;text-align:center;">
                <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:4px;">New (Week)</div>
                <div style="font-size:20px;font-weight:800;color:#6366f1;">${num(inv.new_this_week)}</div>
            </div>
        </div>
    </div>

    <!-- Terminal Breakdown -->
    <div style="padding:16px 32px 0;">
        <div style="font-size:12px;font-weight:700;color:#64748b;margin-bottom:8px;">Terminal Type Breakdown</div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tbody>${termBreakdown || '<tr><td colspan="2" style="padding:12px;text-align:center;color:#94a3b8;font-size:12px;">No data</td></tr>'}</tbody>
        </table>
    </div>

    <!-- Deployments -->
    <div style="padding:24px 32px 0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <div style="font-size:13px;font-weight:800;color:#002d5a;">🚚 Deployments</div>
            <div style="display:flex;gap:12px;">
                <span style="font-size:11px;color:#dc2626;font-weight:700;">${num(dep.open)} Open</span>
                <span style="font-size:11px;color:#16a34a;font-weight:700;">${num(dep.closed)} Closed</span>
                <span style="font-size:11px;color:#6366f1;font-weight:700;">+${num(dep.new_this_week)} this week</span>
            </div>
        </div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">Most recent 10 deployments</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">ID</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Merchant</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Terminal</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Type</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Status</th>
            </tr></thead>
            <tbody>${depRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No deployments</td></tr>'}</tbody>
        </table>
    </div>

    <!-- Deployments from Yesterday -->
    <div style="padding:24px 32px 0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <div style="font-size:13px;font-weight:800;color:#002d5a;">📅 Deployments from Yesterday</div>
            <span style="font-size:11px;color:#6366f1;font-weight:700;">${num((yday.deployments || []).length)} ticket(s)</span>
        </div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">${yday.label} · full list attached as CSV</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">ID</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Merchant</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Terminal</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Type</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Tracking</th>
            </tr></thead>
            <tbody>${ydayRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No deployments created yesterday</td></tr>'}</tbody>
        </table>
    </div>

    <!-- Returns from Yesterday -->
    <div style="padding:24px 32px 0;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <div style="font-size:13px;font-weight:800;color:#002d5a;">📅 Returns from Yesterday</div>
            <span style="font-size:11px;color:#6366f1;font-weight:700;">${num((yday.returns || []).length)} return(s)</span>
        </div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">${yday.label}${(yday.returns || []).length ? ' · full list attached as CSV' : ''}</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">ID</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Merchant</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Terminal</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Reason</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Destination</th>
            </tr></thead>
            <tbody>${ydayRetRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No returns created yesterday</td></tr>'}</tbody>
        </table>
    </div>

    <!-- Returns -->
    <div style="padding:24px 32px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
            <div style="font-size:13px;font-weight:800;color:#002d5a;">↩️ Returns</div>
            <div style="display:flex;gap:12px;">
                <span style="font-size:11px;color:#dc2626;font-weight:700;">${num(ret.open)} Open</span>
                <span style="font-size:11px;color:#16a34a;font-weight:700;">${num(ret.closed)} Closed</span>
                <span style="font-size:11px;color:#6366f1;font-weight:700;">+${num(ret.new_this_week)} this week</span>
            </div>
        </div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">Most recent 10 returns</div>
        <table style="width:100%;border-collapse:collapse;">
            <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0;">
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">ID</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Merchant</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Terminal</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Reason</th>
                <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;">Status</th>
            </tr></thead>
            <tbody>${retRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No returns</td></tr>'}</tbody>
        </table>
    </div>

    <div style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;">
        <div style="font-size:11px;color:#94a3b8;text-align:center;">Automated operations report from your Partner Management Console. To unsubscribe, contact your super admin.</div>
    </div>
</div></body></html>`;
}

// ── PRIME49 EMAIL ─────────────────────────────────────────────────────────────

function buildPrime49Email(data) {
    const {
        date, totalPartners, totalMerchants, totalVolume30d,
        totalNetResidual, totalPptResidual, totalAgentResidual,
        newIdsThisWeek, newMerchantsThisWeek,
        partnerBreakdown, newIdDetails, newMerchantDetails
    } = data;

    const fmt2 = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

    const partnerRows = (partnerBreakdown || []).map((p, i) => `
        <tr style="border-bottom:1px solid #f1f5f9;${i % 2 === 0 ? '' : 'background:#fafafa;'}">
            <td style="padding:9px 12px;font-weight:700;color:#002d5a;font-size:13px;">${p.partner_name}</td>
            <td style="padding:9px 12px;font-size:11px;color:#64748b;font-family:monospace;">${p.id_strings}</td>
            <td style="padding:9px 12px;text-align:center;font-weight:700;color:#475569;font-size:12px;">${p.merchant_count}</td>
            <td style="padding:9px 12px;text-align:right;font-weight:700;color:#002d5a;font-size:12px;">${fmt2(p.volume_30d)}</td>
            <td style="padding:9px 12px;text-align:right;font-weight:700;color:#059669;font-size:13px;">${fmt2(p.agent_payout)}</td>
            <td style="padding:9px 12px;text-align:right;font-weight:600;color:#004990;font-size:12px;">${fmt2(p.ppt_share)}</td>
            <td style="padding:9px 12px;text-align:center;font-size:11px;color:#64748b;">${p.rev_share}%</td>
        </tr>`).join('');

    const newIdRows = (newIdDetails || []).map(r => `
        <tr style="border-bottom:1px solid #fef3c7;">
            <td style="padding:7px 12px;font-family:monospace;font-size:12px;color:#92400e;font-weight:700;">${r.id_string}</td>
            <td style="padding:7px 12px;color:#475569;font-size:12px;">${r.agent_name || '—'}</td>
            <td style="padding:7px 12px;color:#64748b;font-size:11px;">${r.agent_company || '—'}</td>
            <td style="padding:7px 12px;color:#64748b;font-size:11px;">${r.rev_share}%</td>
            <td style="padding:7px 12px;color:#94a3b8;font-size:11px;">${dtFmt(r.created_at)}</td>
        </tr>`).join('');

    const newMerchantRows = (newMerchantDetails || []).map(r => {
        const stColor = r.account_status === 'Approved' ? '#16a34a' : r.account_status === 'Approved - Collections' ? '#d97706' : '#64748b';
        return `
        <tr style="border-bottom:1px solid #f0fdf4;">
            <td style="padding:8px 12px;font-weight:700;color:#002d5a;font-size:13px;">${r.dba_name || '—'}</td>
            <td style="padding:8px 12px;font-family:monospace;font-size:12px;color:#0369a1;font-weight:700;">${r.merchant_id || '—'}</td>
            <td style="padding:8px 12px;font-family:monospace;font-size:11px;color:#64748b;">${r.agent_id || '—'}</td>
            <td style="padding:8px 12px;color:#475569;font-size:12px;">${r.partner_name || '—'}</td>
            <td style="padding:8px 12px;font-size:11px;font-weight:700;color:${stColor};">${r.account_status || '—'}</td>
            <td style="padding:8px 12px;color:#94a3b8;font-size:11px;">${dtFmt(r.enrollment_date)}</td>
        </tr>`;
    }).join('');

    const kpi = (label, val, sub, accent) => `
        <div style="padding:18px 14px;border-right:1px solid #e2e8f0;text-align:center;">
            <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">${label}</div>
            <div style="font-size:18px;font-weight:800;color:${accent || '#002d5a'};">${val}</div>
            ${sub ? `<div style="font-size:10px;color:#64748b;font-weight:600;margin-top:2px;">${sub}</div>` : ''}
        </div>`;

    return `<!DOCTYPE html><html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:720px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

    <!-- HEADER -->
    <div style="background:linear-gradient(135deg,#92400e 0%,#d97706 100%);padding:32px 40px;">
        <div style="color:rgba(255,255,255,0.75);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">💎 Prime49 Program</div>
        <div style="color:white;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Residuals Report</div>
        <div style="color:rgba(255,255,255,0.75);font-size:13px;margin-top:4px;">${date}</div>
    </div>

    <!-- KPI STRIP -->
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:0;border-bottom:1px solid #e2e8f0;">
        ${kpi('Partners', num(totalPartners), null, '#0369a1')}
        ${kpi('Merchants', num(totalMerchants), 'approved/collections', '#002d5a')}
        ${kpi('30-Day Volume', fmt(totalVolume30d), null, '#002d5a')}
        ${kpi('Net Residual Pool', fmt(totalNetResidual), null, '#334155')}
        ${kpi('PPT Share', fmt2(totalPptResidual), '50/50 split', '#004990')}
        ${kpi('Partner Payouts', fmt2(totalAgentResidual), 'total owed', '#059669')}
    </div>

    <!-- DAILY ACTIVITY BADGES -->
    <div style="padding:16px 24px;background:#fffbeb;border-bottom:1px solid #fde68a;display:flex;gap:20px;align-items:center;flex-wrap:wrap;">
        <div style="font-size:11px;font-weight:800;color:#92400e;text-transform:uppercase;letter-spacing:0.5px;">Since Yesterday</div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
            <div style="background:white;border:1px solid #fde68a;border-radius:8px;padding:6px 14px;">
                <span style="font-size:18px;font-weight:900;color:#92400e;">${newIdsThisWeek}</span>
                <span style="font-size:11px;color:#78350f;margin-left:5px;">New Prime49 IDs</span>
            </div>
            <div style="background:white;border:1px solid #bbf7d0;border-radius:8px;padding:6px 14px;">
                <span style="font-size:18px;font-weight:900;color:#059669;">${newMerchantsThisWeek}</span>
                <span style="font-size:11px;color:#065f46;margin-left:5px;">New Merchants Enrolled</span>
            </div>
        </div>
    </div>

    <!-- PARTNER BREAKDOWN TABLE -->
    <div style="padding:24px 24px 0;">
        <div style="font-size:14px;font-weight:800;color:#002d5a;margin-bottom:14px;">Partner Residual Breakdown</div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
            <thead>
                <tr style="background:#f8fafc;">
                    <th style="padding:9px 12px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Partner</th>
                    <th style="padding:9px 12px;text-align:left;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Agent ID(s)</th>
                    <th style="padding:9px 12px;text-align:center;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Merchants</th>
                    <th style="padding:9px 12px;text-align:right;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">30D Volume</th>
                    <th style="padding:9px 12px;text-align:right;font-size:10px;font-weight:700;color:#059669;text-transform:uppercase;letter-spacing:0.5px;">Partner Payout</th>
                    <th style="padding:9px 12px;text-align:right;font-size:10px;font-weight:700;color:#004990;text-transform:uppercase;letter-spacing:0.5px;">PPT Share</th>
                    <th style="padding:9px 12px;text-align:center;font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Rev%</th>
                </tr>
            </thead>
            <tbody>${partnerRows || '<tr><td colspan="7" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No active prime49 merchants</td></tr>'}</tbody>
            <tfoot>
                <tr style="background:#1e293b;">
                    <td colspan="2" style="padding:10px 12px;font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">Grand Total</td>
                    <td style="padding:10px 12px;text-align:center;font-weight:800;color:white;font-size:13px;">${num(totalMerchants)}</td>
                    <td style="padding:10px 12px;text-align:right;font-weight:800;color:white;font-size:13px;">${fmt(totalVolume30d)}</td>
                    <td style="padding:10px 12px;text-align:right;font-weight:800;color:#6ee7b7;font-size:13px;">${fmt2(totalAgentResidual)}</td>
                    <td style="padding:10px 12px;text-align:right;font-weight:800;color:#93c5fd;font-size:13px;">${fmt2(totalPptResidual)}</td>
                    <td></td>
                </tr>
            </tfoot>
        </table>
    </div>

    ${newIdsThisWeek > 0 ? `
    <!-- NEW IDs SINCE YESTERDAY -->
    <div style="padding:24px 24px 0;">
        <div style="font-size:14px;font-weight:800;color:#92400e;margin-bottom:4px;">💎 New Prime49 IDs Since Yesterday (${newIdsThisWeek})</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:10px;">Agent identifiers flagged as Prime49 added in the last 24 hours</div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #fde68a;border-radius:10px;overflow:hidden;">
            <thead>
                <tr style="background:#fffbeb;">
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;">Agent ID</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;">Partner</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;">Company</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;">Rev%</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;">Added</th>
                </tr>
            </thead>
            <tbody>${newIdRows}</tbody>
        </table>
    </div>` : ''}

    ${newMerchantsThisWeek > 0 ? `
    <!-- NEW MERCHANTS SINCE YESTERDAY -->
    <div style="padding:24px 24px 0;">
        <div style="font-size:14px;font-weight:800;color:#059669;margin-bottom:4px;">🏪 Newly Enrolled Merchants (${newMerchantsThisWeek})</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:10px;">Prime49 merchants enrolled since yesterday — existing partners only</div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #bbf7d0;border-radius:10px;overflow:hidden;">
            <thead>
                <tr style="background:#f0fdf4;">
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#065f46;text-transform:uppercase;">DBA Name</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#065f46;text-transform:uppercase;">MID</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#065f46;text-transform:uppercase;">Agent ID</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#065f46;text-transform:uppercase;">Partner</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#065f46;text-transform:uppercase;">Status</th>
                    <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;color:#065f46;text-transform:uppercase;">Enrolled</th>
                </tr>
            </thead>
            <tbody>${newMerchantRows}</tbody>
        </table>
    </div>` : `
    <div style="padding:24px 24px 0;">
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;text-align:center;">
            <div style="font-size:13px;color:#16a34a;font-weight:700;">✓ No new merchant enrollments since yesterday</div>
        </div>
    </div>`}

    <!-- CALCULATION METHODOLOGY -->
    <div style="margin:24px 24px 0;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
        <div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">How Residuals Are Calculated</div>
        <div style="font-size:11px;color:#475569;line-height:1.7;">
            <b>Step 1:</b> Agent Share = 30-Day Volume × <b>1.5%</b> (Prime49 rate)<br>
            <b>Step 2:</b> Net Residual Pool = Agent Share ÷ Partner Rev% (grossed up)<br>
            <b>Step 3:</b> Partner Payout = Net Residual × Partner Rev% &nbsp;|&nbsp; PPT Share = Net Residual × (100% − Rev%)<br>
            <b>Standard split:</b> 50/50 unless a custom rev share is set on the ID.
        </div>
    </div>

    <!-- FOOTER -->
    <div style="padding:24px 40px;margin-top:24px;border-top:1px solid #f1f5f9;text-align:center;">
        <div style="font-size:11px;color:#94a3b8;">PayProTec Internal Report · Prime49 Residuals · ${date}</div>
        <div style="font-size:10px;color:#cbd5e1;margin-top:4px;">This is an automated report from the PayProTec Console.</div>
    </div>

</div></body></html>`;
}

// ── DATA BUILDERS ────────────────────────────────────────────────────────────

async function buildPartnersData() {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Week start = Monday 00:00 UTC
    const weekStart = new Date(today);
    weekStart.setUTCHours(0, 0, 0, 0);
    weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
    const weekStartDate = weekStart.toISOString().slice(0, 10); // 'YYYY-MM-DD'

    // Read directly from the cache table — one fast indexed row read.
    // Calling get_merchant_aggregate_stats() via RPC triggers a full cache rebuild
    // when the cache is cold, which exceeds PostgREST's HTTP-level timeout and kills
    // the report. Instead we read stale-ok data here and fire a background refresh.
    const { data: cache, error: cacheErr } = await supabase
        .from('merchant_aggregate_stats_cache')
        .select('*')
        .eq('id', 1)
        .maybeSingle();

    if (cacheErr) throw cacheErr;

    if (!cache) {
        // No cache row at all — do a one-time blocking warm-up (first ever run only).
        const warmup = await supabase.rpc('get_merchant_aggregate_stats');
        if (warmup.error) throw new Error('Cache empty and warm-up failed: ' + warmup.error.message);
        const { data: fresh } = await supabase
            .from('merchant_aggregate_stats_cache').select('*').eq('id', 1).maybeSingle();
        if (!fresh) throw new Error('Cache still empty after warm-up.');
        return buildPartnersDataFromCache(fresh, dateStr, [], null, []);
    }

    // If stale (> 4 h), trigger background refresh without blocking the send.
    const staleMs = 4 * 60 * 60 * 1000;
    if (!cache.computed_at || Date.now() - new Date(cache.computed_at).getTime() > staleMs) {
        supabase.rpc('get_merchant_aggregate_stats').then(() => {}).catch(() => {});
    }

    // Fresh live query for this week's merchant enrollments (Monday-based, not rolling 7d).
    // Used for partner activity accuracy and the new merchants detail table.
    const { data: weeklyMerchants } = await supabase
        .from('merchants')
        .select('merchant_id, dba_name, account_status, agent_name, enrollment_date')
        .gte('enrollment_date', weekStartDate)
        .not('agent_name', 'is', null)
        .neq('agent_name', '')
        .limit(1000);

    // Build topSubmittingPartners from live data grouped by agent_name
    const agentWeekMap = {};
    (weeklyMerchants || []).forEach(m => {
        if (!agentWeekMap[m.agent_name]) agentWeekMap[m.agent_name] = { agent_name: m.agent_name, submitted: 0, approved: 0 };
        agentWeekMap[m.agent_name].submitted++;
        if (m.account_status === 'Approved') agentWeekMap[m.agent_name].approved++;
    });
    const freshTopSubmitting = Object.values(agentWeekMap)
        .sort((a, b) => b.submitted - a.submitted)
        .slice(0, 10);

    // New merchants detail with MIDs (most recent first, capped at 30 for email length)
    const newMerchantsDetail = (weeklyMerchants || [])
        .sort((a, b) => (b.enrollment_date || '').localeCompare(a.enrollment_date || ''))
        .slice(0, 30)
        .map(m => ({
            merchant_id:    m.merchant_id,
            dba_name:       m.dba_name,
            agent_name:     m.agent_name,
            account_status: m.account_status,
            enrollment_date: m.enrollment_date
        }));

    // Leaderboard is a separate fast query with no cache rebuild side-effect.
    const leaderboardRes = await supabase.rpc('get_partner_leaderboard', { lim: 10 });

    return buildPartnersDataFromCache(cache, dateStr, leaderboardRes.data, freshTopSubmitting, newMerchantsDetail);
}

function buildPartnersDataFromCache(cache, dateStr, leaderboard = [], topSubmittingOverride = null, newMerchantsDetail = []) {
    const sortedBreakdown = Object.fromEntries(
        Object.entries(cache.status_breakdown || {}).sort(([, a], [, b]) => b - a)
    );
    const topSubmittingPartners = topSubmittingOverride !== null
        ? topSubmittingOverride
        : (Array.isArray(cache.top_submitting_partners) ? cache.top_submitting_partners : []);
    return {
        date:                  dateStr,
        totalMerchants:        Number(cache.total            || 0),
        approvedMerchants:     Number(cache.approved         || 0),
        totalVolume30d:        Number(cache.vol30            || 0),
        totalVolume90d:        Number(cache.vol90            || 0),
        newMerchantsYesterday: Number(cache.new_yesterday    || 0),
        newMerchantsThisWeek:  Number(cache.new_this_week    || 0),
        approvedThisWeek:      Number(cache.approved_this_week || 0),
        newAgentsThisWeek:     Number(cache.new_agents_this_week || 0),
        topPartners:           Array.isArray(leaderboard) ? leaderboard : [],
        topSubmittingPartners,
        statusBreakdown:       sortedBreakdown,
        newMerchantsDetail
    };
}


async function buildPrime49Data() {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Daily cutoff: yesterday midnight UTC — captures a full prior day regardless of send time
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    const sinceIso = yesterday.toISOString();
    const sinceDate = sinceIso.slice(0, 10); // 'YYYY-MM-DD' for date-field comparison

    // 1. Fetch all approved prime49 merchants with volume
    const { data: merchants, error: mErr } = await supabase
        .from('merchant_portfolio_view')
        .select('merchant_id, dba_name, volume_30_day, agent_id, partner_full_name, company_display_name, enrollment_date, account_status')
        .eq('is_prime49', true)
        .in('account_status', ['Approved', 'Approved - Collections'])
        .limit(10000);
    if (mErr) throw mErr;

    // 2. Fetch rev_share for all agent IDs in the result
    const agentIds = [...new Set((merchants || []).map(m => m.agent_id).filter(Boolean))];
    let revShareMap = {};
    if (agentIds.length) {
        const { data: aiData } = await supabase
            .from('agent_identifiers').select('id_string, rev_share').in('id_string', agentIds).limit(10000);
        (aiData || []).forEach(ai => { revShareMap[ai.id_string] = ai.rev_share; });
    }

    // 3. New Prime49 IDs added since yesterday (daily window)
    const { data: newIds } = await supabase
        .from('agent_identifiers')
        .select('id_string, rev_share, agent_id, created_at')
        .eq('prime49', true)
        .gte('created_at', sinceIso)
        .limit(500);

    // Enrich new IDs with agent/company names
    const newIdAgentIds = [...new Set((newIds || []).map(r => r.agent_id).filter(Boolean))];
    let newIdAgentMap = {};
    if (newIdAgentIds.length) {
        const { data: agRows } = await supabase.from('agents').select('id, agent_name, company_id').in('id', newIdAgentIds);
        const coIds = [...new Set((agRows || []).map(a => a.company_id).filter(Boolean))];
        let coMap = {};
        if (coIds.length) {
            const { data: coRows } = await supabase.from('companies').select('id, company_name').in('id', coIds);
            (coRows || []).forEach(c => { coMap[c.id] = c.company_name; });
        }
        (agRows || []).forEach(a => { newIdAgentMap[a.id] = { agent_name: a.agent_name, agent_company: coMap[a.company_id] || '—' }; });
    }

    const newIdDetails = (newIds || []).map(r => {
        const ag = newIdAgentMap[r.agent_id] || {};
        const revPct = parseFloat(String(r.rev_share || '50').replace(/%/g, '')) || 50;
        return { id_string: r.id_string, agent_name: ag.agent_name || '—', agent_company: ag.agent_company || '—', rev_share: revPct, created_at: r.created_at };
    });

    // 4. New merchants enrolled since yesterday on prime49 IDs (for existing partners)
    const newMerchantDetails = (merchants || [])
        .filter(m => m.enrollment_date && m.enrollment_date >= sinceDate)
        .sort((a, b) => (b.enrollment_date || '').localeCompare(a.enrollment_date || ''))
        .map(m => ({
            dba_name:       m.dba_name,
            merchant_id:    m.merchant_id,
            agent_id:       m.agent_id,
            partner_name:   m.partner_full_name,
            account_status: m.account_status,
            enrollment_date: m.enrollment_date
        }));

    // 5. Build per-partner aggregates
    const partnerMap = {};
    (merchants || []).forEach(m => {
        const key = m.partner_full_name || '—';
        if (!partnerMap[key]) partnerMap[key] = { partner_name: key, ids: new Set(), merchant_count: 0, volume_30d: 0, agent_payout: 0, ppt_share: 0, rev_shares: [] };
        const g = partnerMap[key];
        if (m.agent_id) g.ids.add(m.agent_id);
        const vol = parseFloat(m.volume_30_day) || 0;
        const rawRev = revShareMap[m.agent_id];
        const revPct = rawRev ? parseFloat(String(rawRev).replace(/%/g, '')) : 50;
        const agentShare = vol * 0.015;
        const netResid = agentShare * 2;
        g.merchant_count++;
        g.volume_30d   += vol;
        g.agent_payout += netResid * (revPct / 100);
        g.ppt_share    += netResid * (1 - revPct / 100);
        g.rev_shares.push(revPct);
    });

    const partnerBreakdown = Object.values(partnerMap)
        .sort((a, b) => b.agent_payout - a.agent_payout)
        .map(g => ({
            partner_name:  g.partner_name,
            id_strings:    [...g.ids].join(', '),
            merchant_count: g.merchant_count,
            volume_30d:    g.volume_30d,
            agent_payout:  g.agent_payout,
            ppt_share:     g.ppt_share,
            rev_share:     g.rev_shares.length ? Math.round(g.rev_shares.reduce((a, b) => a + b, 0) / g.rev_shares.length) : 50
        }));

    // 6. Totals
    const totalVolume30d    = partnerBreakdown.reduce((s, p) => s + p.volume_30d, 0);
    const totalAgentResidual = partnerBreakdown.reduce((s, p) => s + p.agent_payout, 0);
    const totalPptResidual  = partnerBreakdown.reduce((s, p) => s + p.ppt_share, 0);
    const totalNetResidual  = totalAgentResidual + totalPptResidual;

    return {
        date: dateStr,
        totalPartners:       partnerBreakdown.length,
        totalMerchants:      (merchants || []).length,
        totalVolume30d,
        totalNetResidual,
        totalPptResidual,
        totalAgentResidual,
        newIdsThisWeek:      (newIds || []).length,
        newMerchantsThisWeek: newMerchantDetails.length,
        partnerBreakdown,
        newIdDetails,
        newMerchantDetails
    };
}

async function buildOpsData() {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    const { data, error } = await supabase.rpc('get_ops_report_stats');
    if (error) throw error;

    // Yesterday's deployments + returns (timezone-aware, tz handled in SQL)
    const [{ data: yDeps }, { data: yRets }] = await Promise.all([
        supabase.rpc('get_ops_yesterday_deployments'),
        supabase.rpc('get_ops_yesterday_returns')
    ]);
    const yesterdayLabel = new Date(today.getTime() - 86400000)
        .toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    return { date: dateStr, yesterday: { label: yesterdayLabel, deployments: yDeps || [], returns: yRets || [] }, ...data };
}

// ── ACTIVITY LOGS REPORT ─────────────────────────────────────────────────────

// Classify a free-text action into a verb bucket (what they did).
function classifyAction(a) {
    const s = (a || '').toLowerCase();
    if (/search|lookup|query/.test(s)) return 'Search';
    if (/login|log in|logout|log out|sign|auth|password|2fa|token/.test(s)) return 'Auth';
    if (/delet|remov|void|scrap|decommission/.test(s)) return 'Delete';
    if (/complet|clos|deliver|receiv|approv|finaliz|stock/.test(s)) return 'Complete';
    if (/updat|edit|chang|modif|renam|assign|set |toggle|merge/.test(s)) return 'Update';
    if (/creat|added|\badd\b|filed|enroll|new |generat|deploy|initiat|import|upload/.test(s)) return 'Create';
    if (/sent|send|email|notif|invite/.test(s)) return 'Send';
    if (/view|open|print|export|download/.test(s)) return 'View';
    return 'Other';
}

async function getActivityExcludes() {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'activity_report_excluded_emails').maybeSingle();
    try { const arr = JSON.parse(data?.value || '[]'); return Array.isArray(arr) ? arr.map(e => String(e).toLowerCase()) : []; }
    catch { return []; }
}

async function buildActivityData() {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Window follows the configured schedule: monthly = 30d, weekly = 7d, daily = 24h
    const { data: sched } = await supabase.from('report_schedule_settings').select('schedule').eq('report_type', 'activity').maybeSingle();
    const sc = sched?.schedule || 'weekly';
    const days = sc === 'monthly' ? 30 : sc === 'weekly' ? 7 : 1;
    const since = new Date(today.getTime() - days * 86400000);
    const sinceIso = since.toISOString();
    const windowLabel = sc === 'monthly' ? 'Past 30 days' : sc === 'weekly' ? 'Past 7 days' : 'Past 24 hours';

    const excluded = new Set(await getActivityExcludes());

    // Pull the window's logs (paginated, capped)
    let rows = [], off = 0, done = false;
    while (!done) {
        const { data: batch } = await supabase.from('activity_logs')
            .select('email, category, action, created_at')
            .gte('created_at', sinceIso)
            .order('created_at', { ascending: false })
            .range(off, off + 999);
        if (!batch || !batch.length) done = true;
        else { rows = rows.concat(batch); off += 1000; if (batch.length < 1000 || off >= 20000) done = true; }
    }

    const byUser = {}, byCat = {}, byAction = {};
    let total = 0;
    for (const r of rows) {
        const em = (r.email || '').toLowerCase();
        if (!em || excluded.has(em)) continue;
        const cat = r.category || 'other';
        const verb = classifyAction(r.action);
        if (!byUser[em]) byUser[em] = { total: 0, cats: {}, actions: {} };
        byUser[em].total++;
        byUser[em].cats[cat] = (byUser[em].cats[cat] || 0) + 1;
        byUser[em].actions[verb] = (byUser[em].actions[verb] || 0) + 1;
        byCat[cat] = (byCat[cat] || 0) + 1;
        byAction[verb] = (byAction[verb] || 0) + 1;
        total++;
    }

    const emails = Object.keys(byUser);
    let nameMap = {};
    if (emails.length) {
        const { data: us } = await supabase.from('app_users').select('email, first_name, last_name').in('email', emails);
        (us || []).forEach(u => { nameMap[(u.email || '').toLowerCase()] = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email; });
    }
    const topUsers = emails.map(em => ({
        email: em, name: nameMap[em] || em, count: byUser[em].total,
        byCategory: Object.entries(byUser[em].cats).map(([c, n]) => ({ category: c, count: n })).sort((a, b) => b.count - a.count),
        byAction: Object.entries(byUser[em].actions).map(([a, n]) => ({ action: a, count: n })).sort((a, b) => b.count - a.count)
    })).sort((a, b) => b.count - a.count).slice(0, 15);
    const topCats = Object.entries(byCat).map(([c, n]) => ({ category: c, count: n })).sort((a, b) => b.count - a.count).slice(0, 10);
    const topActions = Object.entries(byAction).map(([a, n]) => ({ action: a, count: n })).sort((a, b) => b.count - a.count);

    return { date: dateStr, windowLabel, schedule: sc, totalEvents: total, activeUsers: emails.length, topUsers, topCats, topActions, excludedCount: excluded.size };
}

function buildActivityEmail(data) {
    const { date, windowLabel, totalEvents, activeUsers, topUsers, topCats, excludedCount } = data;
    const medal = i => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
    const maxCount = (topUsers[0]?.count) || 1;
    const catChips = (cats) => (cats || []).map(c =>
        `<span style="display:inline-block;background:#ede9fe;color:#5b21b6;border-radius:6px;padding:1px 7px;margin:2px 3px 0 0;font-size:10px;font-weight:600;text-transform:capitalize;">${c.category} ${num(c.count)}</span>`).join('');
    const actChips = (acts) => (acts || []).map(a =>
        `<span style="display:inline-block;background:#dcfce7;color:#166534;border-radius:6px;padding:1px 7px;margin:2px 3px 0 0;font-size:10px;font-weight:600;">${a.action} ${num(a.count)}</span>`).join('');
    const userRows = (topUsers || []).map((u, i) => `
        <tr style="border-bottom:1px solid #f1f5f9;${i < 3 ? 'background:#faf5ff;' : ''}">
            <td style="padding:10px 12px;font-weight:700;color:#7c3aed;font-size:13px;width:36px;text-align:center;vertical-align:top;">${medal(i)}</td>
            <td style="padding:10px 12px;font-size:13px;color:#1e293b;font-weight:${i < 3 ? '700' : '600'};vertical-align:top;">
                ${u.name}<br><span style="font-size:10px;color:#94a3b8;font-weight:400;">${u.email}</span>
                <div style="margin-top:5px;line-height:1.7;"><span style="font-size:9px;color:#a78bfa;font-weight:700;">BY AREA:</span> ${catChips(u.byCategory)}</div>
                <div style="margin-top:3px;line-height:1.7;"><span style="font-size:9px;color:#4ade80;font-weight:700;">DID:</span> ${actChips(u.byAction)}</div>
            </td>
            <td style="padding:10px 12px;width:38%;vertical-align:top;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <div style="flex:1;height:8px;background:#ede9fe;border-radius:4px;overflow:hidden;"><div style="height:100%;width:${Math.round((u.count / maxCount) * 100)}%;background:#7c3aed;"></div></div>
                    <span style="font-weight:800;color:#5b21b6;font-size:13px;min-width:36px;text-align:right;">${num(u.count)}</span>
                </div>
                <div style="font-size:9px;color:#94a3b8;text-align:right;margin-top:2px;text-transform:uppercase;letter-spacing:.5px;">total</div>
            </td>
        </tr>`).join('');
    const catRows = (topCats || []).map(c => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:7px 12px;font-size:12px;color:#334155;text-transform:capitalize;">${c.category}</td>
            <td style="padding:7px 12px;font-size:12px;font-weight:700;color:#5b21b6;text-align:right;">${num(c.count)}</td>
        </tr>`).join('');
    const actionRows = (data.topActions || []).map(a => `
        <tr style="border-bottom:1px solid #f1f5f9;">
            <td style="padding:7px 12px;font-size:12px;color:#334155;">${a.action}</td>
            <td style="padding:7px 12px;font-size:12px;font-weight:700;color:#166534;text-align:right;">${num(a.count)}</td>
        </tr>`).join('');

    return `<!DOCTYPE html><html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:680px;margin:32px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#5b21b6 0%,#7c3aed 100%);padding:32px 40px;">
        <div style="color:rgba(255,255,255,0.7);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Activity Logs Report</div>
        <div style="color:white;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Most Active Users</div>
        <div style="color:rgba(255,255,255,0.7);font-size:13px;margin-top:4px;">${date} · ${windowLabel}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid #e2e8f0;">
        <div style="padding:18px 16px;border-right:1px solid #e2e8f0;">
            <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Total Events</div>
            <div style="font-size:22px;font-weight:800;color:#5b21b6;">${num(totalEvents)}</div>
        </div>
        <div style="padding:18px 16px;">
            <div style="font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Active Users</div>
            <div style="font-size:22px;font-weight:800;color:#5b21b6;">${num(activeUsers)}</div>
        </div>
    </div>
    <div style="padding:24px 32px 0;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:4px;">🏆 Top Users by Activity</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">${windowLabel}${excludedCount ? ` · ${excludedCount} user(s) excluded` : ''}</div>
        <table style="width:100%;border-collapse:collapse;">
            <tbody>${userRows || '<tr><td style="padding:16px;text-align:center;color:#94a3b8;font-size:12px;">No activity in this window</td></tr>'}</tbody>
        </table>
    </div>
    <div style="padding:24px 32px 0;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:4px;">Activity by Category</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">Where the events happened</div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tbody>${catRows || '<tr><td colspan="2" style="padding:12px;text-align:center;color:#94a3b8;font-size:12px;">No data</td></tr>'}</tbody>
        </table>
    </div>
    <div style="padding:24px 32px;">
        <div style="font-size:13px;font-weight:800;color:#002d5a;margin-bottom:4px;">Activity by Action Type</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:12px;">What people did (create / update / search / …)</div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
            <tbody>${actionRows || '<tr><td colspan="2" style="padding:12px;text-align:center;color:#94a3b8;font-size:12px;">No data</td></tr>'}</tbody>
        </table>
    </div>
    <div style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;">
        <div style="font-size:11px;color:#94a3b8;text-align:center;">Automated activity report from your Partner Management Console. Excluded users are configured in Secret Dungeon.</div>
    </div>
</div></body></html>`;
}

// ── SEND HELPERS ─────────────────────────────────────────────────────────────

async function getStaffConfig(reportType) {
    const onKey = `report_sendall_${reportType}`;
    const listKey = `report_staff_recipients_${reportType}`;
    const { data } = await supabase.from('app_settings').select('key, value').in('key', [onKey, listKey]);
    const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
    let list = null;
    try { list = map[listKey] != null ? JSON.parse(map[listKey]) : null; } catch { list = null; }
    return {
        sendAll: map[onKey] === 'true',
        // recipients = explicit WHITELIST of staff who receive; null = "not set yet" (= everyone)
        recipients: Array.isArray(list) ? list.map(e => String(e).toLowerCase()) : null
    };
}

async function sendReport(reportType, trigger = 'cron', testEmail = null) {
    let recipients;
    if (testEmail) {
        recipients = [{ email: testEmail, name: 'Test' }];
    } else {
        const { sendAll, recipients: whitelist } = await getStaffConfig(reportType);
        if (sendAll) {
            // Send to the CHECKED staff (whitelist). null = everyone (no explicit picks yet).
            const { data: staff } = await supabase.from('app_users').select('email, first_name, last_name, is_active');
            const active = (staff || []).filter(u => u.is_active !== false && u.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email));
            let chosen;
            if (whitelist === null) chosen = active;
            else { const set = new Set(whitelist); chosen = active.filter(u => set.has(u.email.toLowerCase())); }
            recipients = chosen.map(u => ({ email: u.email, name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email }));
            if (!recipients.length) return { sent: 0, skipped: 'no staff selected', report_type: reportType };
        }
    }
    if (!recipients) {
        const { data, error } = await supabase
            .from('report_recipients').select('email, name')
            .eq('report_type', reportType);
        if (error) throw error;
        recipients = data;
    }
    if (!recipients || recipients.length === 0) return { sent: 0, skipped: 'no recipients', report_type: reportType };

    let html, subject, reportData, attachments = null;
    try {
        if (reportType === 'ops') {
            reportData = await buildOpsData();
            html = buildOpsEmail(reportData);
            subject = `📦 Operations Report — ${reportData.date}`;
            // Attach yesterday's deployments + returns as SEPARATE CSVs.
            // Only attach a CSV when that list has rows (no empty attachments).
            const esc = v => {
                const s = (v === null || v === undefined) ? '' : String(v);
                return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            };
            const toCsv = (rows, header, rowFn) =>
                [header.join(','), ...rows.map(r => rowFn(r).map(esc).join(','))].join('\n');
            const b64 = s => Buffer.from(s, 'utf8').toString('base64');
            const slug = (reportData.yesterday?.label || 'yesterday').replace(/[^a-z0-9]+/gi, '_');
            const att = [];

            const yDeps = reportData.yesterday?.deployments || [];
            if (yDeps.length) {
                const csv = toCsv(yDeps,
                    ['Deployment ID', 'Created At', 'Merchant', 'MID', 'Terminal Type', 'Serials', 'Purchase Type', 'Tracking', 'Bulk', 'Status'],
                    d => [d.deployment_id, d.created_at, d.dba_name, d.merchant_id, d.terminal_type, d.serials, d.purchase_type, d.tracking_id, d.is_bulk ? 'Yes' : 'No', d.status]);
                att.push({ Name: `deployments_${slug}.csv`, Content: b64(csv), ContentType: 'text/csv' });
            }

            const yRets = reportData.yesterday?.returns || [];
            if (yRets.length) {
                const csv = toCsv(yRets,
                    ['Return ID', 'Created At', 'Merchant', 'MID', 'Terminal Type', 'Serials', 'Reason', 'Condition', 'Destination', 'Status'],
                    r => [r.return_id, r.created_at, r.dba_name, r.merchant_id, r.terminal_type, r.serials, r.return_reason, r.condition, r.destination, r.status]);
                att.push({ Name: `returns_${slug}.csv`, Content: b64(csv), ContentType: 'text/csv' });
            }

            if (att.length) attachments = att;
        } else if (reportType === 'prime49') {
            reportData = await buildPrime49Data();
            html = buildPrime49Email(reportData);
            subject = `💎 Prime49 Daily Update — ${reportData.date}`;
        } else if (reportType === 'activity') {
            reportData = await buildActivityData();
            html = buildActivityEmail(reportData);
            subject = `📋 Activity Leaderboard — ${reportData.date}`;
        } else {
            reportData = await buildPartnersData();
            html = buildPartnersEmail(reportData);
            subject = `📊 Partners & Merchants Report — ${reportData.date}`;
        }
    } catch (buildErr) {
        await supabase.from('report_send_log').insert({
            trigger, report_type: reportType, recipient_count: 0, status: 'failed',
            error_message: `Data build failed: ${buildErr.message}`
        });
        throw buildErr;
    }

    if (!process.env.POSTMARK_SERVER_TOKEN) throw new Error('POSTMARK_SERVER_TOKEN not configured');
    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);

    const emailPayload = {
        From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
        Subject: subject,
        HtmlBody: html,
        MessageStream: 'outbound'
    };
    if (attachments) emailPayload.Attachments = attachments;

    const results = await Promise.allSettled(
        recipients.map(r => client.sendEmail({ ...emailPayload, To: r.email }))
    );

    let sent = 0;
    const errors = [];
    results.forEach((r, i) => {
        if (r.status === 'fulfilled') { sent++; }
        else { errors.push(`${recipients[i].email}: ${r.reason?.message || 'unknown error'}`); }
    });

    await supabase.from('report_send_log').insert({
        trigger,
        report_type: reportType,
        recipient_count: sent,
        status: errors.length > 0 ? (sent > 0 ? 'partial' : 'failed') : 'sent',
        error_message: errors.length > 0 ? errors.join('; ') : null
    });

    return { sent, total: recipients.length, errors, report_type: reportType };
}

// Legacy export kept for cron-daily-report.js
export async function sendDailyReport(trigger = 'cron') {
    return sendReport('partners_merchants', trigger);
}

export async function sendScheduledReports(schedule, trigger = 'cron', currentHour = null) {
    const { data: settings } = await supabase
        .from('report_schedule_settings')
        .select('report_type, enabled, preferred_hour')
        .eq('schedule', schedule)
        .eq('enabled', true);

    if (!settings || settings.length === 0) return [];

    const due = currentHour === null
        ? settings
        : settings.filter(s => (s.preferred_hour ?? 9) === currentHour);

    if (due.length === 0) return [{ skipped: true, reason: `not the scheduled hour (${currentHour})` }];
    return Promise.all(due.map(s => sendReport(s.report_type, trigger)));
}

// ── HTTP HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    // Verify caller has sending_reports access (or is super_admin) — never trust client
    const { data: caller } = await supabase.from('app_users')
        .select('role, access_sending_reports').eq('userid', session.userid).maybeSingle();
    if (caller?.role !== 'super_admin' && !caller?.access_sending_reports) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    res.setHeader('Content-Type', 'application/json');
    const { action, email, name, id, report_type = 'partners_merchants', schedule } = req.body;

    try {
        if (action === 'get_recipients') {
            const { data, error } = await supabase.from('report_recipients')
                .select('*').eq('report_type', report_type).order('created_at', { ascending: true });
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'add_recipient') {
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ success: false, message: 'Invalid email address' });
            }
            const { error } = await supabase.from('report_recipients')
                .insert({ email: email.toLowerCase().trim(), name: name || null, report_type });
            if (error) {
                if (error.code === '23505') return res.status(409).json({ success: false, message: 'Email already exists for this report' });
                throw error;
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'remove_recipient') {
            const { error } = await supabase.from('report_recipients').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // Activity-report excluded users (e.g. the developer's own login)
        if (action === 'get_activity_excludes') {
            const { data } = await supabase.from('app_settings').select('value').eq('key', 'activity_report_excluded_emails').maybeSingle();
            let arr = []; try { arr = JSON.parse(data?.value || '[]'); } catch { arr = []; }
            return res.status(200).json({ success: true, data: Array.isArray(arr) ? arr : [] });
        }
        if (action === 'add_activity_exclude' || action === 'remove_activity_exclude') {
            const em = (req.body.email || '').toLowerCase().trim();
            if (action === 'add_activity_exclude' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
                return res.status(400).json({ success: false, message: 'Invalid email address' });
            }
            const { data } = await supabase.from('app_settings').select('value').eq('key', 'activity_report_excluded_emails').maybeSingle();
            let arr = []; try { arr = JSON.parse(data?.value || '[]'); } catch { arr = []; }
            if (!Array.isArray(arr)) arr = [];
            if (action === 'add_activity_exclude') { if (!arr.includes(em)) arr.push(em); }
            else { arr = arr.filter(x => x !== em); }
            const { error } = await supabase.from('app_settings').upsert({ key: 'activity_report_excluded_emails', value: JSON.stringify(arr), updated_at: new Date().toISOString() }, { onConflict: 'key' });
            if (error) throw error;
            return res.status(200).json({ success: true, data: arr });
        }

        // List all active staff (for the recipient checklist)
        if (action === 'list_staff') {
            const { data } = await supabase.from('app_users')
                .select('email, first_name, last_name, is_active')
                .order('first_name', { ascending: true });
            const staff = (data || [])
                .filter(u => u.email && u.is_active !== false)
                .map(u => ({ email: u.email, name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email }));
            return res.status(200).json({ success: true, data: staff });
        }

        // Staff recipient picker (whitelist) per report type
        if (action === 'get_sendall') {
            const cfg = await getStaffConfig(report_type);
            return res.status(200).json({ success: true, ...cfg });
        }
        // Save the FULL chosen-staff list in one write (avoids read-modify-write races).
        // sendAll flag = true whenever a list is provided; false when cleared.
        if (action === 'set_staff_recipients') {
            const emails = Array.isArray(req.body.emails)
                ? [...new Set(req.body.emails.map(e => String(e).toLowerCase().trim()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))]
                : [];
            const now = new Date().toISOString();
            const { error: e1 } = await supabase.from('app_settings').upsert(
                { key: `report_staff_recipients_${report_type}`, value: JSON.stringify(emails), updated_at: now }, { onConflict: 'key' });
            if (e1) throw e1;
            const { error: e2 } = await supabase.from('app_settings').upsert(
                { key: `report_sendall_${report_type}`, value: emails.length ? 'true' : 'false', updated_at: now }, { onConflict: 'key' });
            if (e2) throw e2;
            return res.status(200).json({ success: true, count: emails.length });
        }

        // Add several staff to the recipients list at once (from the staff picker)
        if (action === 'add_recipients_bulk') {
            const recips = Array.isArray(req.body.recipients) ? req.body.recipients : [];
            const clean = recips
                .map(r => ({ email: String(r.email || '').toLowerCase().trim(), name: r.name || null }))
                .filter(r => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
            if (!clean.length) return res.status(400).json({ success: false, message: 'No valid staff selected' });
            const { data: existing } = await supabase.from('report_recipients').select('email').eq('report_type', report_type);
            const have = new Set((existing || []).map(e => (e.email || '').toLowerCase()));
            const seen = new Set();
            const toInsert = clean
                .filter(r => !have.has(r.email) && !seen.has(r.email) && seen.add(r.email))
                .map(r => ({ email: r.email, name: r.name, report_type }));
            if (toInsert.length) {
                const { error } = await supabase.from('report_recipients').insert(toInsert);
                if (error) throw error;
            }
            return res.status(200).json({ success: true, added: toInsert.length, skipped: clean.length - toInsert.length });
        }

        if (action === 'send_now') {
            const result = await sendReport(report_type, 'manual');
            return res.status(200).json({ success: true, ...result });
        }

        if (action === 'send_test') {
            const testEmail = (req.body.test_email || '').trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
                return res.status(400).json({ success: false, message: 'Invalid test email' });
            }
            const result = await sendReport(report_type, 'test', testEmail);
            return res.status(200).json({ success: true, ...result });
        }

        if (action === 'get_log') {
            const { data, error } = await supabase.from('report_send_log')
                .select('*').eq('report_type', report_type).order('sent_at', { ascending: false }).limit(20);
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'get_schedule') {
            const { data, error } = await supabase.from('report_schedule_settings').select('*');
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'set_schedule') {
            const { error } = await supabase.from('report_schedule_settings')
                .upsert({ report_type, schedule, enabled: true, updated_at: new Date().toISOString() }, { onConflict: 'report_type' });
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'set_time') {
            const hour = parseInt(req.body.preferred_hour, 10);
            if (isNaN(hour) || hour < 0 || hour > 23) {
                return res.status(400).json({ success: false, message: 'preferred_hour must be 0–23' });
            }
            const { error } = await supabase.from('report_schedule_settings')
                .upsert({ report_type, preferred_hour: hour, updated_at: new Date().toISOString() }, { onConflict: 'report_type' });
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'send_manual') {
            const result = await sendReport(report_type, 'manual');
            return res.status(200).json({ success: true, ...result });
        }

        if (action === 'refresh_cache') {
            // Explicitly rebuild the merchant aggregate cache — call this before sending
            // or from a cron that runs a few minutes before the report schedule.
            const warmup = await supabase.rpc('get_merchant_aggregate_stats');
            if (warmup.error) throw warmup.error;
            const { data: row } = await supabase
                .from('merchant_aggregate_stats_cache').select('computed_at').eq('id', 1).maybeSingle();
            return res.status(200).json({ success: true, computed_at: row?.computed_at });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('Scheduled Reports Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
