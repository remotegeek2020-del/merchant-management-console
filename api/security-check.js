import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body;

    async function safeQuery(fn) {
        try { return await fn(); } catch (e) { return { data: null, error: e, count: null }; }
    }

    try {
        if (action === 'list_emails') {
            const { data, error } = await supabase.from('security_check_emails').select('*').order('created_at');
            if (error) throw error;
            return res.status(200).json({ success: true, emails: data || [] });
        }

        if (action === 'add_email') {
            const { email } = req.body;
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
                return res.status(400).json({ success: false, message: 'Invalid email address.' });
            const { error } = await supabase.from('security_check_emails').insert({ email });
            if (error) {
                if (error.code === '23505') return res.status(409).json({ success: false, message: 'Email already exists.' });
                throw error;
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'remove_email') {
            const { id } = req.body;
            const { error } = await supabase.from('security_check_emails').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'get_last_report') {
            const { data, error } = await supabase.from('security_check_reports')
                .select('*').order('run_at', { ascending: false }).limit(1).single();
            if (error && error.code !== 'PGRST116') throw error;
            return res.status(200).json({ success: true, report: data || null });
        }

        if (action === 'run_check') {
            const sections = [];

            // ── 1. Environment Variables ──────────────────────────────────────
            const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'POSTMARK_SERVER_TOKEN', 'EMAIL_FROM'];
            const envChecks = requiredEnvVars.map(v => ({
                name: v,
                status: process.env[v] ? 'pass' : 'fail',
                detail: process.env[v] ? 'Present' : 'MISSING — related features will not work'
            }));
            sections.push({
                title: 'Environment Variables',
                icon: 'key',
                status: envChecks.some(c => c.status === 'fail') ? 'fail' : 'pass',
                checks: envChecks
            });

            // ── 2. Access Control ─────────────────────────────────────────────
            const { data: inactiveWithAccess } = await safeQuery(() =>
                supabase.from('users')
                    .select('first_name, last_name, email')
                    .eq('is_active', false)
                    .or('access_admin_dashboard.eq.true,access_inventory.eq.true,access_deployments.eq.true,access_returns.eq.true,access_merchants.eq.true,access_partners.eq.true')
            );

            const accessChecks = [];
            if (inactiveWithAccess && inactiveWithAccess.length > 0) {
                accessChecks.push({
                    name: 'Inactive staff with active permissions',
                    status: 'warn',
                    detail: `${inactiveWithAccess.length} inactive user(s) still have access flags: ${inactiveWithAccess.map(u => u.email || `${u.first_name} ${u.last_name}`).join(', ')}`
                });
            } else {
                accessChecks.push({ name: 'Inactive staff with active permissions', status: 'pass', detail: 'No inactive users with lingering access flags' });
            }

            sections.push({
                title: 'Access Control',
                icon: 'manage_accounts',
                status: accessChecks.some(c => c.status === 'fail') ? 'fail' : accessChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: accessChecks
            });

            // ── 3. Failed Login Activity (last 24h) ───────────────────────────
            const since24h = new Date(Date.now() - 86400000).toISOString();
            const { data: failedLogins } = await safeQuery(() =>
                supabase.from('activity_logs')
                    .select('email, action, created_at')
                    .eq('status', 'FAILURE')
                    .gte('created_at', since24h)
                    .order('created_at', { ascending: false })
            );

            const failCount = failedLogins?.length || 0;
            const byEmail = {};
            (failedLogins || []).forEach(l => { byEmail[l.email] = (byEmail[l.email] || 0) + 1; });
            const topFailers = Object.entries(byEmail).sort((a, b) => b[1] - a[1]).slice(0, 5);

            let loginStatus = 'pass';
            let loginDetail = 'No failed logins in the last 24 hours';
            if (failCount >= 10) {
                loginStatus = 'fail';
                loginDetail = `HIGH: ${failCount} failed login attempts! Top: ${topFailers.map(([e, n]) => `${e} (${n}x)`).join(', ')}`;
            } else if (failCount > 0) {
                loginStatus = 'warn';
                loginDetail = `${failCount} failed attempt(s) in last 24h: ${topFailers.map(([e, n]) => `${e} (${n}x)`).join(', ')}`;
            }

            sections.push({
                title: 'Login Security',
                icon: 'lock',
                status: loginStatus,
                checks: [{ name: 'Failed login attempts (24h)', status: loginStatus, detail: loginDetail }]
            });

            // ── 4. Data Integrity ─────────────────────────────────────────────
            const [orphanDepsRes, orphanReturnsRes, nullStatusRes] = await Promise.all([
                safeQuery(() => supabase.from('deployments').select('*', { count: 'exact', head: true }).or('merchant_id.is.null,equipment_id.is.null')),
                safeQuery(() => supabase.from('returns').select('*', { count: 'exact', head: true }).is('equipment_id', null)),
                safeQuery(() => supabase.from('equipments').select('*', { count: 'exact', head: true }).is('status', null))
            ]);

            const integrityChecks = [
                {
                    name: 'Orphaned deployments (missing merchant or equipment)',
                    status: (orphanDepsRes.count || 0) > 0 ? 'warn' : 'pass',
                    detail: (orphanDepsRes.count || 0) > 0 ? `${orphanDepsRes.count} deployment(s) missing merchant or equipment link` : 'All deployments have valid links'
                },
                {
                    name: 'Returns without equipment link',
                    status: (orphanReturnsRes.count || 0) > 0 ? 'warn' : 'pass',
                    detail: (orphanReturnsRes.count || 0) > 0 ? `${orphanReturnsRes.count} return(s) have no equipment linked` : 'All returns have equipment linked'
                },
                {
                    name: 'Equipment records with null status',
                    status: (nullStatusRes.count || 0) > 0 ? 'warn' : 'pass',
                    detail: (nullStatusRes.count || 0) > 0 ? `${nullStatusRes.count} equipment record(s) have no status set` : 'All equipment has a status value'
                }
            ];

            sections.push({
                title: 'Data Integrity',
                icon: 'storage',
                status: integrityChecks.some(c => c.status === 'fail') ? 'fail' : integrityChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: integrityChecks
            });

            // ── 5. Operational Health ─────────────────────────────────────────
            const since48h  = new Date(Date.now() - 172800000).toISOString();
            const since7d   = new Date(Date.now() - 604800000).toISOString();
            const since14d  = new Date(Date.now() - 1209600000).toISOString();

            const [stalledTicketsRes, oldOpenRmasRes, stuckTransitRes] = await Promise.all([
                safeQuery(() =>
                    supabase.from('support_tickets')
                        .select('ticket_number, subject, created_at')
                        .not('status', 'in', '(closed,resolved)')
                        .or('assigned_to.is.null,assigned_to.eq.')
                        .lt('created_at', since48h)
                        .order('created_at', { ascending: true })
                        .limit(10)
                ),
                safeQuery(() =>
                    supabase.from('returns')
                        .select('return_id, created_at')
                        .ilike('status', 'open')
                        .lt('created_at', since7d)
                        .limit(10)
                ),
                safeQuery(() =>
                    supabase.from('deployments')
                        .select('deployment_id, created_at')
                        .eq('status', 'In Transit')
                        .lt('created_at', since14d)
                        .limit(10)
                )
            ]);

            const stalledTickets = stalledTicketsRes.data || [];
            const oldOpenRmas = oldOpenRmasRes.data || [];
            const stuckTransit = stuckTransitRes.data || [];

            const opChecks = [
                {
                    name: 'Unassigned open tickets older than 48h',
                    status: stalledTickets.length > 0 ? 'warn' : 'pass',
                    detail: stalledTickets.length > 0
                        ? `${stalledTickets.length} ticket(s) unassigned: ${stalledTickets.map(t => t.ticket_number).join(', ')}`
                        : 'All open tickets are assigned'
                },
                {
                    name: 'Open RMAs older than 7 days',
                    status: oldOpenRmas.length > 0 ? 'warn' : 'pass',
                    detail: oldOpenRmas.length > 0
                        ? `${oldOpenRmas.length} RMA(s) still open: ${oldOpenRmas.map(r => r.return_id).join(', ')}`
                        : 'No stale open RMAs'
                },
                {
                    name: 'Deployments stuck In Transit longer than 14 days',
                    status: stuckTransit.length > 0 ? 'warn' : 'pass',
                    detail: stuckTransit.length > 0
                        ? `${stuckTransit.length} deployment(s) stuck in transit: ${stuckTransit.map(d => d.deployment_id).join(', ')}`
                        : 'No deployments stuck in transit'
                }
            ];

            sections.push({
                title: 'Operational Health',
                icon: 'monitor_heart',
                status: opChecks.some(c => c.status === 'fail') ? 'fail' : opChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: opChecks
            });

            // ── Overall status & save ─────────────────────────────────────────
            const allStatuses = sections.map(s => s.status);
            const overall = allStatuses.includes('fail') ? 'fail' : allStatuses.includes('warn') ? 'warn' : 'pass';

            const report = { timestamp: new Date().toISOString(), overall_status: overall, sections };

            await supabase.from('security_check_reports').insert({
                overall_status: overall,
                report_json: report,
                triggered_by: req.body.triggered_by || 'manual'
            });

            // ── Send email ────────────────────────────────────────────────────
            const { data: emailList } = await supabase.from('security_check_emails').select('email');
            if (emailList?.length && process.env.POSTMARK_SERVER_TOKEN) {
                const statusIcon  = overall === 'pass' ? '✅' : overall === 'warn' ? '⚠️' : '❌';
                const statusLabel = overall === 'pass' ? 'All Clear' : overall === 'warn' ? 'Warnings Found' : 'Issues Detected';
                const statusColor = overall === 'pass' ? '#166534' : overall === 'warn' ? '#92400e' : '#991b1b';
                const statusBg    = overall === 'pass' ? '#dcfce7' : overall === 'warn' ? '#fef3c7' : '#fee2e2';

                const sectionHtml = sections.map(s => {
                    const sColor = s.status === 'pass' ? '#166534' : s.status === 'warn' ? '#92400e' : '#991b1b';
                    const sBg    = s.status === 'pass' ? '#dcfce7' : s.status === 'warn' ? '#fef3c7' : '#fee2e2';
                    const checksHtml = s.checks.map(c => {
                        const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
                        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${icon} <strong>${c.name}</strong><div style="font-size:12px;color:#64748b;margin-top:2px;">${c.detail}</div></td></tr>`;
                    }).join('');
                    return `<div style="margin-bottom:20px;">
                        <div style="background:${sBg};color:${sColor};padding:8px 14px;border-radius:6px 6px 0 0;font-weight:700;font-size:13px;">${s.title}</div>
                        <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-top:none;">${checksHtml}</table>
                    </div>`;
                }).join('');

                const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:40px 20px;">
                    <img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:36px;margin-bottom:24px;display:block;">
                    <div style="background:${statusBg};color:${statusColor};padding:16px 20px;border-radius:10px;margin-bottom:24px;font-size:16px;font-weight:700;">
                        ${statusIcon} Security Check — ${statusLabel}
                        <div style="font-size:12px;font-weight:400;margin-top:4px;opacity:0.8;">Run at ${new Date().toLocaleString()}</div>
                    </div>
                    ${sectionHtml}
                    <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0;">
                    <p style="font-size:11px;color:#94a3b8;text-align:center;">PayProTec · Daily Security Check</p>
                </div>`;

                try {
                    const { ServerClient } = await import('postmark');
                    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                    await Promise.all(emailList.map(({ email }) =>
                        client.sendEmail({
                            From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
                            To: email,
                            Subject: `${statusIcon} Security Check — ${statusLabel} — ${new Date().toLocaleDateString()}`,
                            HtmlBody: htmlBody,
                            TextBody: `Security Check: ${statusLabel}. Run at ${new Date().toLocaleString()}.`,
                            MessageStream: 'outbound'
                        })
                    ));
                } catch (e) {
                    console.error('[SECURITY CHECK] Email failed:', e.message);
                }
            }

            return res.status(200).json({ success: true, report });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (err) {
        console.error('Security Check Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
