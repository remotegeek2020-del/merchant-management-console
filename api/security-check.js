import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body;

    try {
        // --- Email management ---
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

        // --- Run full security check ---
        if (action === 'run_check') {
            const sections = [];

            // ── 1. Environment Variables ──────────────────────────────────────
            const requiredEnvVars = [
                'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
                'POSTMARK_SERVER_TOKEN', 'EMAIL_FROM'
            ];
            const envChecks = requiredEnvVars.map(v => ({
                name: v,
                status: process.env[v] ? 'pass' : 'fail',
                detail: process.env[v] ? 'Present' : 'MISSING — functionality may be broken'
            }));
            sections.push({
                title: 'Environment Variables',
                icon: 'key',
                status: envChecks.some(c => c.status === 'fail') ? 'fail' : 'pass',
                checks: envChecks
            });

            // ── 2. Database Security (RLS) ────────────────────────────────────
            const { data: rlsData } = await supabase.rpc('check_rls_status').catch(() => ({ data: null }));
            // Fallback: query pg_tables directly
            const { data: tableRows } = await supabase
                .from('pg_tables')
                .select('tablename')
                .eq('schemaname', 'public')
                .catch(() => ({ data: null }));

            // Use raw SQL to check RLS
            const rlsResult = await supabase.rpc('get_merchant_kpis').catch(() => null); // warm up connection
            const { data: rlsRaw } = await supabase
                .from('information_schema.tables')
                .select('table_name')
                .eq('table_schema', 'public')
                .eq('table_type', 'BASE TABLE')
                .catch(() => ({ data: [] }));

            // Check tables without RLS via a direct query
            const rlsCheckQuery = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/check_tables_rls`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
                },
                body: '{}'
            }).then(r => r.json()).catch(() => null);

            // Directly query pg_class for RLS via execute_sql equivalent
            const { data: tablesNoRls } = await supabase.rpc('list_tables_without_rls').catch(() => ({ data: null }));

            const rlsChecks = [];
            if (tablesNoRls && Array.isArray(tablesNoRls) && tablesNoRls.length > 0) {
                rlsChecks.push({ name: 'Row Level Security', status: 'warn', detail: `${tablesNoRls.length} table(s) without RLS: ${tablesNoRls.join(', ')}` });
            } else {
                rlsChecks.push({ name: 'Row Level Security', status: tablesNoRls ? 'pass' : 'info', detail: tablesNoRls ? 'All public tables have RLS enabled' : 'Unable to verify — check manually' });
            }

            // ── 3. Access Control ─────────────────────────────────────────────
            const { data: inactiveWithAccess } = await supabase
                .from('users')
                .select('id, first_name, last_name, email')
                .eq('is_active', false)
                .or('access_admin_dashboard.eq.true,access_inventory.eq.true,access_deployments.eq.true,access_returns.eq.true,access_merchants.eq.true,access_partners.eq.true');

            const accessChecks = [];
            if (inactiveWithAccess && inactiveWithAccess.length > 0) {
                accessChecks.push({
                    name: 'Inactive staff with active permissions',
                    status: 'warn',
                    detail: `${inactiveWithAccess.length} inactive user(s) still have access flags: ${inactiveWithAccess.map(u => u.email || `${u.first_name} ${u.last_name}`).join(', ')}`
                });
            } else {
                accessChecks.push({ name: 'Inactive staff with active permissions', status: 'pass', detail: 'No inactive users with lingering access' });
            }

            sections.push({
                title: 'Access Control',
                icon: 'manage_accounts',
                status: accessChecks.some(c => c.status === 'fail') ? 'fail' : accessChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: accessChecks
            });

            // ── 4. Failed Login Activity (last 24h) ───────────────────────────
            const since24h = new Date(Date.now() - 86400000).toISOString();
            const { data: failedLogins } = await supabase
                .from('activity_logs')
                .select('email, action, created_at')
                .eq('status', 'FAILURE')
                .gte('created_at', since24h)
                .order('created_at', { ascending: false });

            const loginChecks = [];
            const failCount = failedLogins?.length || 0;
            const byEmail = {};
            (failedLogins || []).forEach(l => { byEmail[l.email] = (byEmail[l.email] || 0) + 1; });
            const topFailers = Object.entries(byEmail).sort((a, b) => b[1] - a[1]).slice(0, 5);

            if (failCount === 0) {
                loginChecks.push({ name: 'Failed login attempts (24h)', status: 'pass', detail: 'No failed logins in the last 24 hours' });
            } else if (failCount < 10) {
                loginChecks.push({ name: 'Failed login attempts (24h)', status: 'warn', detail: `${failCount} failed attempt(s): ${topFailers.map(([e, n]) => `${e} (${n}x)`).join(', ')}` });
            } else {
                loginChecks.push({ name: 'Failed login attempts (24h)', status: 'fail', detail: `HIGH: ${failCount} failed attempts! Top offenders: ${topFailers.map(([e, n]) => `${e} (${n}x)`).join(', ')}` });
            }

            sections.push({
                title: 'Login Security',
                icon: 'lock',
                status: loginChecks[0].status,
                checks: loginChecks
            });

            // ── 5. Data Integrity ─────────────────────────────────────────────
            const [
                { count: orphanDeps },
                { count: orphanReturns },
                { count: nullStatusEquip },
                { data: dupeSerials }
            ] = await Promise.all([
                supabase.from('deployments').select('*', { count: 'exact', head: true }).or('merchant_id.is.null,equipment_id.is.null'),
                supabase.from('returns').select('*', { count: 'exact', head: true }).is('equipment_id', null),
                supabase.from('equipments').select('*', { count: 'exact', head: true }).or('status.is.null,status.eq.'),
                supabase.rpc('find_duplicate_serials').catch(() => ({ data: [] }))
            ]);

            const integrityChecks = [
                {
                    name: 'Orphaned deployments (no merchant or equipment)',
                    status: (orphanDeps || 0) > 0 ? 'warn' : 'pass',
                    detail: (orphanDeps || 0) > 0 ? `${orphanDeps} deployment(s) missing merchant or equipment link` : 'All deployments have valid links'
                },
                {
                    name: 'Returns without equipment link',
                    status: (orphanReturns || 0) > 0 ? 'warn' : 'pass',
                    detail: (orphanReturns || 0) > 0 ? `${orphanReturns} return record(s) have no equipment linked` : 'All returns have equipment linked'
                },
                {
                    name: 'Equipment with null/empty status',
                    status: (nullStatusEquip || 0) > 0 ? 'warn' : 'pass',
                    detail: (nullStatusEquip || 0) > 0 ? `${nullStatusEquip} equipment record(s) have no status set` : 'All equipment has a status'
                }
            ];

            sections.push({
                title: 'Data Integrity',
                icon: 'storage',
                status: integrityChecks.some(c => c.status === 'fail') ? 'fail' : integrityChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: integrityChecks
            });

            // ── 6. Operational Health ─────────────────────────────────────────
            const since48h = new Date(Date.now() - 172800000).toISOString();
            const since7d  = new Date(Date.now() - 604800000).toISOString();
            const since14d = new Date(Date.now() - 1209600000).toISOString();

            const [
                { data: stalledTickets },
                { data: oldOpenRmas },
                { data: stuckTransit }
            ] = await Promise.all([
                supabase.from('support_tickets')
                    .select('ticket_number, subject, created_at')
                    .not('status', 'in', '(closed,resolved)')
                    .or('assigned_to.is.null,assigned_to.eq.')
                    .lt('created_at', since48h)
                    .order('created_at', { ascending: true })
                    .limit(10),
                supabase.from('returns')
                    .select('return_id, created_at')
                    .ilike('status', 'open')
                    .lt('created_at', since7d)
                    .limit(10),
                supabase.from('deployments')
                    .select('deployment_id, created_at')
                    .eq('status', 'In Transit')
                    .lt('created_at', since14d)
                    .limit(10)
            ]);

            const opChecks = [
                {
                    name: 'Unassigned open tickets >48h',
                    status: (stalledTickets?.length || 0) > 0 ? 'warn' : 'pass',
                    detail: (stalledTickets?.length || 0) > 0
                        ? `${stalledTickets.length} ticket(s) unassigned: ${stalledTickets.map(t => t.ticket_number).join(', ')}`
                        : 'All open tickets are assigned'
                },
                {
                    name: 'Open RMAs older than 7 days',
                    status: (oldOpenRmas?.length || 0) > 0 ? 'warn' : 'pass',
                    detail: (oldOpenRmas?.length || 0) > 0
                        ? `${oldOpenRmas.length} RMA(s) still open: ${oldOpenRmas.map(r => r.return_id).join(', ')}`
                        : 'No stale open RMAs'
                },
                {
                    name: 'Deployments stuck In Transit >14 days',
                    status: (stuckTransit?.length || 0) > 0 ? 'warn' : 'pass',
                    detail: (stuckTransit?.length || 0) > 0
                        ? `${stuckTransit.length} deployment(s) stuck: ${stuckTransit.map(d => d.deployment_id).join(', ')}`
                        : 'No deployments stuck in transit'
                }
            ];

            sections.push({
                title: 'Operational Health',
                icon: 'monitor_heart',
                status: opChecks.some(c => c.status === 'fail') ? 'fail' : opChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: opChecks
            });

            // ── Compute overall status ────────────────────────────────────────
            const allStatuses = sections.map(s => s.status);
            const overall = allStatuses.includes('fail') ? 'fail' : allStatuses.includes('warn') ? 'warn' : 'pass';

            const report = {
                timestamp: new Date().toISOString(),
                overall_status: overall,
                sections
            };

            // Save report to DB
            await supabase.from('security_check_reports').insert({
                overall_status: overall,
                report_json: report,
                triggered_by: req.body.triggered_by || 'manual'
            });

            // Send email if recipients configured
            const { data: emailList } = await supabase.from('security_check_emails').select('email');
            if (emailList?.length && process.env.POSTMARK_SERVER_TOKEN) {
                const statusIcon = overall === 'pass' ? '✅' : overall === 'warn' ? '⚠️' : '❌';
                const statusLabel = overall === 'pass' ? 'All Clear' : overall === 'warn' ? 'Warnings Found' : 'Issues Detected';
                const statusColor = overall === 'pass' ? '#166534' : overall === 'warn' ? '#92400e' : '#991b1b';
                const statusBg = overall === 'pass' ? '#dcfce7' : overall === 'warn' ? '#fef3c7' : '#fee2e2';

                const sectionHtml = sections.map(s => {
                    const sColor = s.status === 'pass' ? '#166534' : s.status === 'warn' ? '#92400e' : s.status === 'fail' ? '#991b1b' : '#475569';
                    const sBg = s.status === 'pass' ? '#dcfce7' : s.status === 'warn' ? '#fef3c7' : s.status === 'fail' ? '#fee2e2' : '#f1f5f9';
                    const checksHtml = s.checks.map(c => {
                        const cIcon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : c.status === 'fail' ? '❌' : 'ℹ️';
                        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${cIcon} <strong>${c.name}</strong><div style="font-size:12px;color:#64748b;margin-top:2px;">${c.detail}</div></td></tr>`;
                    }).join('');
                    return `<div style="margin-bottom:20px;">
                        <div style="background:${sBg};color:${sColor};padding:8px 14px;border-radius:6px 6px 0 0;font-weight:700;font-size:13px;">${s.title}</div>
                        <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-top:none;">${checksHtml}</table>
                    </div>`;
                }).join('');

                const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:40px 20px;">
                    <img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:36px;margin-bottom:24px;display:block;">
                    <div style="background:${statusBg};color:${statusColor};padding:16px 20px;border-radius:10px;margin-bottom:24px;font-size:16px;font-weight:700;">
                        ${statusIcon} Daily Security Check — ${statusLabel}
                        <div style="font-size:12px;font-weight:400;margin-top:4px;opacity:0.8;">Run at ${new Date().toLocaleString()}</div>
                    </div>
                    ${sectionHtml}
                    <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0;">
                    <p style="font-size:11px;color:#94a3b8;text-align:center;">PayProTec · Daily Security Check · Secret Dungeon</p>
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
                            TextBody: `Security Check: ${statusLabel}. Run at ${new Date().toLocaleString()}. Log in to Secret Dungeon to view the full report.`,
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
