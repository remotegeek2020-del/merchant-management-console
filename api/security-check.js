import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body;

    // Always returns a result — never throws out of the check runner
    async function safeQuery(fn) {
        try { return await fn(); } catch (e) { return { data: null, error: e, count: null }; }
    }

    try {
        if (action === 'get_schedule') {
            const { data } = await supabase.from('report_schedule_settings')
                .select('schedule, enabled, preferred_hour')
                .eq('report_type', 'security')
                .maybeSingle();
            return res.status(200).json({ success: true, schedule: data || { schedule: 'daily', enabled: true, preferred_hour: 8 } });
        }

        if (action === 'set_schedule') {
            const { schedule, enabled, preferred_hour } = req.body;
            const validSchedules = ['daily', 'twice_daily', 'weekly'];
            if (schedule && !validSchedules.includes(schedule))
                return res.status(400).json({ success: false, message: 'Invalid schedule value.' });
            await supabase.from('report_schedule_settings').upsert({
                report_type: 'security',
                schedule: schedule ?? 'daily',
                enabled: enabled !== false,
                preferred_hour: typeof preferred_hour === 'number' ? preferred_hour : 8,
                updated_at: new Date().toISOString()
            }, { onConflict: 'report_type' });
            return res.status(200).json({ success: true });
        }

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
            const now = Date.now();
            const since24h  = new Date(now - 86400000).toISOString();
            const since7d   = new Date(now - 604800000).toISOString();
            const since14d  = new Date(now - 1209600000).toISOString();
            const since30d  = new Date(now - 2592000000).toISOString();
            const since48h  = new Date(now - 172800000).toISOString();
            const since60d  = new Date(now - 5184000000).toISOString();
            const since90d  = new Date(now - 7776000000).toISOString();

            // ── 1. Environment & Configuration ────────────────────────────────
            const coreEnvVars = [
                'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
                'POSTMARK_SERVER_TOKEN', 'EMAIL_FROM'
            ];
            const optionalEnvVars = ['GEMINI_API_KEY'];

            const envChecks = [
                ...coreEnvVars.map(v => ({
                    name: v,
                    status: process.env[v] ? 'pass' : 'fail',
                    detail: process.env[v] ? 'Present and configured' : 'MISSING — related features will not work'
                })),
                ...optionalEnvVars.map(v => ({
                    name: `${v} (AI / Jarvis)`,
                    status: process.env[v] ? 'pass' : 'warn',
                    detail: process.env[v] ? 'Present and configured' : 'Missing — Jarvis AI features will be disabled'
                }))
            ];

            sections.push({
                title: 'Environment & Configuration',
                icon: 'key',
                status: envChecks.some(c => c.status === 'fail') ? 'fail' : envChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: envChecks
            });

            // ── 2. Database Security ──────────────────────────────────────────
            const [rlsRes, dupSerialsRes, extensionsRes, nullRolesRes, dupInviteTokensRes] = await Promise.all([
                safeQuery(() => supabase.rpc('get_tables_rls_status')),
                safeQuery(() => supabase.rpc('get_duplicate_serials')),
                safeQuery(() => supabase.rpc('get_installed_extensions')),
                safeQuery(() => supabase.from('app_users').select('email').is('role', null).eq('is_active', true)),
                safeQuery(() => supabase.rpc('get_duplicate_invite_tokens'))
            ]);

            const dbSecChecks = [];

            // RLS check
            const rlsTables = rlsRes.data || [];
            const noRlsTables = rlsTables.filter(t => !t.rls_enabled);
            dbSecChecks.push({
                name: 'Row-Level Security (RLS) on all tables',
                status: noRlsTables.length > 0 ? 'warn' : 'pass',
                detail: noRlsTables.length > 0
                    ? `${noRlsTables.length} table(s) without RLS: ${noRlsTables.map(t => t.table_name).join(', ')}`
                    : `All ${rlsTables.length} public tables have RLS enabled`
            });

            // Duplicate serials
            const dupSerials = dupSerialsRes.data || [];
            dbSecChecks.push({
                name: 'Duplicate serial numbers in inventory',
                status: dupSerials.length > 0 ? 'fail' : 'pass',
                detail: dupSerials.length > 0
                    ? `${dupSerials.length} duplicate serial(s): ${dupSerials.map(d => `${d.serial_number} (${d.count}x)`).join(', ')}`
                    : 'No duplicate serial numbers found'
            });

            // Extensions
            const extensions = extensionsRes.data || [];
            const sensitiveExts = extensions.filter(e => ['pg_cron', 'pg_net', 'pgsodium', 'supabase_vault', 'http'].includes(e.name));
            dbSecChecks.push({
                name: 'Installed PostgreSQL extensions audit',
                status: 'info',
                detail: extensions.length > 0
                    ? `${extensions.length} extension(s) installed. Notable: ${sensitiveExts.length > 0 ? sensitiveExts.map(e => e.name).join(', ') : 'none requiring special attention'}`
                    : 'No extensions found or unable to query'
            });

            // Users with no role
            const nullRoleUsers = nullRolesRes.data || [];
            dbSecChecks.push({
                name: 'Active users with no role assigned',
                status: nullRoleUsers.length > 0 ? 'fail' : 'pass',
                detail: nullRoleUsers.length > 0
                    ? `${nullRoleUsers.length} active user(s) have no role: ${nullRoleUsers.map(u => u.email).join(', ')} — these accounts have undefined permissions`
                    : 'All active users have a role assigned'
            });

            // Duplicate invitation tokens (security risk — token reuse)
            const dupTokens = dupInviteTokensRes.data || [];
            dbSecChecks.push({
                name: 'Duplicate invitation tokens',
                status: dupTokens.length > 0 ? 'fail' : 'pass',
                detail: dupTokens.length > 0
                    ? `CRITICAL: ${dupTokens.length} duplicate invitation token(s) found — account takeover risk`
                    : 'All invitation tokens are unique'
            });

            sections.push({
                title: 'Database Security',
                icon: 'shield',
                status: dbSecChecks.some(c => c.status === 'fail') ? 'fail' : dbSecChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: dbSecChecks
            });

            // ── 3. Access Control & Privilege Security ────────────────────────
            const [inactiveAccessRes, superAdminRes, staleAccountsRes, jarvisAccessRes, adminDashAccessRes] = await Promise.all([
                safeQuery(() =>
                    supabase.from('app_users')
                        .select('first_name, last_name, email')
                        .eq('is_active', false)
                        .or('access_admin_dashboard.eq.true,access_inventory.eq.true,access_deployments.eq.true,access_returns.eq.true,access_merchants.eq.true,access_partners.eq.true')
                ),
                safeQuery(() => supabase.rpc('get_super_admin_count')),
                safeQuery(() => supabase.rpc('get_stale_active_accounts')),
                safeQuery(() => supabase.from('app_users').select('email', { count: 'exact', head: true }).eq('access_jarvis', true).eq('is_active', true)),
                safeQuery(() => supabase.from('app_users').select('email', { count: 'exact', head: true }).eq('access_admin_dashboard', true).eq('is_active', true))
            ]);

            const accessChecks = [];

            const inactiveWithAccess = inactiveAccessRes.data || [];
            accessChecks.push(inactiveWithAccess.length > 0 ? {
                name: 'Inactive staff with active permissions',
                status: 'warn',
                detail: `${inactiveWithAccess.length} inactive user(s) still have access flags: ${inactiveWithAccess.map(u => u.email || `${u.first_name} ${u.last_name}`).join(', ')}`
            } : {
                name: 'Inactive staff with active permissions',
                status: 'pass',
                detail: 'No inactive users with lingering access flags'
            });

            const superAdminCount = superAdminRes.data ?? null;
            if (superAdminCount !== null) {
                accessChecks.push({
                    name: 'Super Admin account count',
                    status: superAdminCount > 3 ? 'warn' : 'pass',
                    detail: superAdminCount > 3
                        ? `${superAdminCount} active super admin accounts — review if all are necessary`
                        : `${superAdminCount} active super admin account(s) — within acceptable range`
                });
            }

            const staleAccounts = staleAccountsRes.data || [];
            accessChecks.push(staleAccounts.length > 0 ? {
                name: 'Active accounts with no login in 90+ days',
                status: 'warn',
                detail: `${staleAccounts.length} account(s) may be dormant: ${staleAccounts.map(u => u.email || `${u.first_name} ${u.last_name}`).join(', ')}`
            } : {
                name: 'Active accounts with no login in 90+ days',
                status: 'pass',
                detail: 'All active accounts have recent login activity'
            });

            const jarvisCount = jarvisAccessRes.count || 0;
            accessChecks.push({
                name: 'Staff with Jarvis AI access',
                status: jarvisCount > 5 ? 'warn' : 'info',
                detail: `${jarvisCount} active user(s) have Jarvis access enabled${jarvisCount > 5 ? ' — review if all are necessary' : ''}`
            });

            const adminDashCount = adminDashAccessRes.count || 0;
            accessChecks.push({
                name: 'Staff with admin dashboard access',
                status: adminDashCount > 5 ? 'warn' : 'info',
                detail: `${adminDashCount} active user(s) have admin dashboard access`
            });

            sections.push({
                title: 'Access Control & Privilege Security',
                icon: 'manage_accounts',
                status: accessChecks.some(c => c.status === 'fail') ? 'fail' : accessChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: accessChecks
            });

            // ── 4. Login & Brute-Force Security ───────────────────────────────
            const [failedLoginsRes, bruteForceSuspectsRes, highTfaRes] = await Promise.all([
                safeQuery(() =>
                    supabase.from('activity_logs')
                        .select('email, action, created_at')
                        .eq('status', 'FAILURE')
                        .gte('created_at', since24h)
                        .order('created_at', { ascending: false })
                ),
                safeQuery(() => supabase.rpc('get_brute_force_suspects')),
                safeQuery(() => supabase.rpc('get_high_tfa_attempts'))
            ]);

            const loginChecks = [];

            const failedLogins = failedLoginsRes.data || [];
            const failCount = failedLogins.length;
            const byEmail = {};
            failedLogins.forEach(l => { byEmail[l.email] = (byEmail[l.email] || 0) + 1; });
            const topFailers = Object.entries(byEmail).sort((a, b) => b[1] - a[1]).slice(0, 5);
            let loginStatus = 'pass', loginDetail = 'No failed logins in the last 24 hours';
            if (failCount >= 10) { loginStatus = 'fail'; loginDetail = `HIGH: ${failCount} failed login attempts in 24h. Top: ${topFailers.map(([e, n]) => `${e} (${n}x)`).join(', ')}`; }
            else if (failCount > 0) { loginStatus = 'warn'; loginDetail = `${failCount} failed attempt(s) in last 24h. Top: ${topFailers.map(([e, n]) => `${e} (${n}x)`).join(', ')}`; }
            loginChecks.push({ name: 'Failed login attempts (24h)', status: loginStatus, detail: loginDetail });

            const bruteSuspects = bruteForceSuspectsRes.data || [];
            loginChecks.push(bruteSuspects.length > 0 ? {
                name: 'Brute-force suspects (5+ failures in 1 hour)',
                status: 'fail',
                detail: `ALERT: ${bruteSuspects.length} account(s) under brute-force attack: ${bruteSuspects.map(s => `${s.email} (${s.failure_count}x)`).join(', ')}`
            } : {
                name: 'Brute-force suspects (5+ failures in 1 hour)',
                status: 'pass',
                detail: 'No brute-force patterns detected in the last hour'
            });

            const highTfa = highTfaRes.data || [];
            loginChecks.push(highTfa.length > 0 ? {
                name: '2FA lockout candidates (3+ failed attempts)',
                status: 'warn',
                detail: `${highTfa.length} account(s) with high 2FA failures: ${highTfa.map(u => `${u.email} (${u.tfa_attempts}x)`).join(', ')}`
            } : {
                name: '2FA lockout candidates (3+ failed attempts)',
                status: 'pass',
                detail: 'No accounts with excessive 2FA failures'
            });

            sections.push({
                title: 'Login & Brute-Force Security',
                icon: 'lock',
                status: loginChecks.some(c => c.status === 'fail') ? 'fail' : loginChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: loginChecks
            });

            // ── 5. Session Security ───────────────────────────────────────────
            const [sessionRes, stalePartnerSessionsRes] = await Promise.all([
                safeQuery(() => supabase.rpc('get_session_health')),
                safeQuery(() =>
                    supabase.from('partner_sessions')
                        .select('*', { count: 'exact', head: true })
                        .lt('created_at', since90d)
                )
            ]);

            const sessionData = sessionRes.data?.[0] || {};
            const sessionChecks = [
                {
                    name: 'Expired sessions not yet purged',
                    status: (sessionData.expired_not_purged || 0) > 50 ? 'warn' : 'pass',
                    detail: (sessionData.expired_not_purged || 0) > 50
                        ? `${sessionData.expired_not_purged} expired sessions still in DB — consider purging`
                        : `${sessionData.expired_not_purged || 0} expired sessions pending cleanup (within normal range)`
                },
                {
                    name: 'Active partner sessions',
                    status: 'info',
                    detail: `${sessionData.active_sessions || 0} active partner session(s) currently`
                },
                {
                    name: 'Partners with multiple simultaneous sessions',
                    status: (sessionData.multi_session_persons || 0) > 0 ? 'warn' : 'pass',
                    detail: (sessionData.multi_session_persons || 0) > 0
                        ? `${sessionData.multi_session_persons} partner(s) have more than one active session — possible account sharing`
                        : 'No partners with multiple simultaneous sessions'
                },
                {
                    name: 'Partner sessions older than 90 days',
                    status: (stalePartnerSessionsRes.count || 0) > 0 ? 'warn' : 'pass',
                    detail: (stalePartnerSessionsRes.count || 0) > 0
                        ? `${stalePartnerSessionsRes.count} very old partner session(s) — consider expiring tokens older than 90 days`
                        : 'No partner sessions older than 90 days'
                }
            ];

            sections.push({
                title: 'Session Security',
                icon: 'verified_user',
                status: sessionChecks.some(c => c.status === 'fail') ? 'fail' : sessionChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: sessionChecks
            });

            // ── 6. Partner Portal Security ────────────────────────────────────
            const [invitedNotActivatedRes, portalNoMerchantsRes, partnerApiKeysRes] = await Promise.all([
                safeQuery(() =>
                    supabase.from('persons')
                        .select('full_name, email, enrolled_at', { count: 'exact' })
                        .eq('is_portal_active', true)
                        .eq('portal_password_set', false)
                        .lt('enrolled_at', since14d)
                        .limit(10)
                ),
                safeQuery(() => supabase.rpc('get_portal_partners_without_merchants')),
                safeQuery(() =>
                    supabase.from('partner_api_keys')
                        .select('*', { count: 'exact', head: true })
                        .eq('is_active', true)
                        .lt('last_used_at', since30d)
                )
            ]);

            const portalChecks = [];

            const invitedNotActivated = invitedNotActivatedRes.data || [];
            portalChecks.push({
                name: 'Partners invited but never activated (14+ days)',
                status: invitedNotActivated.length > 0 ? 'warn' : 'pass',
                detail: invitedNotActivated.length > 0
                    ? `${invitedNotActivated.length} partner(s) have portal access but never set a password: ${invitedNotActivated.map(p => p.full_name || p.email).join(', ')}`
                    : 'All invited partners have activated their accounts'
            });

            const portalNoMerchants = portalNoMerchantsRes.data || [];
            portalChecks.push({
                name: 'Active portal partners with no merchants',
                status: portalNoMerchants.length > 5 ? 'warn' : 'info',
                detail: portalNoMerchants.length > 0
                    ? `${portalNoMerchants.length} portal partner(s) have zero merchants linked — may be orphan accounts`
                    : 'All portal partners have at least one merchant'
            });

            const unusedApiKeys = partnerApiKeysRes.count || 0;
            portalChecks.push({
                name: 'Active partner API keys unused in 30+ days',
                status: unusedApiKeys > 0 ? 'warn' : 'pass',
                detail: unusedApiKeys > 0
                    ? `${unusedApiKeys} active API key(s) have not been used in 30+ days — consider revoking`
                    : 'All active API keys have recent activity'
            });

            sections.push({
                title: 'Partner Portal Security',
                icon: 'group',
                status: portalChecks.some(c => c.status === 'fail') ? 'fail' : portalChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: portalChecks
            });

            // ── 7. Data Integrity ─────────────────────────────────────────────
            const [orphanDepsRes, orphanReturnsRes, nullStatusRes, equipConflictsRes,
                   orphanCommentsRes, merchantsNoAgentRes] = await Promise.all([
                // Bulk deployments legitimately have equipment_id = null (units live in
                // deployment_items), so only flag missing merchant, or a SINGLE deployment
                // missing equipment.
                safeQuery(() => supabase.from('deployments').select('*', { count: 'exact', head: true }).or('merchant_id.is.null,and(is_bulk.eq.false,equipment_id.is.null)')),
                safeQuery(() => supabase.from('returns').select('*', { count: 'exact', head: true }).is('equipment_id', null).eq('is_bulk', false)),
                safeQuery(() => supabase.from('equipments').select('*', { count: 'exact', head: true }).is('status', null)),
                safeQuery(() => supabase.rpc('get_equipment_status_conflicts')),
                safeQuery(() =>
                    supabase.from('idea_comments')
                        .select('id', { count: 'exact', head: true })
                        .not('idea_id', 'in',
                            supabase.from('feature_ideas').select('id')
                        )
                ),
                safeQuery(() =>
                    supabase.from('merchants')
                        .select('*', { count: 'exact', head: true })
                        .is('agent_id', null)
                        .eq('account_status', 'Approved')
                )
            ]);

            const integrityChecks = [
                {
                    name: 'Orphaned deployments (missing merchant or equipment)',
                    status: (orphanDepsRes.count || 0) > 0 ? 'warn' : 'pass',
                    detail: (orphanDepsRes.count || 0) > 0
                        ? `${orphanDepsRes.count} deployment(s) missing merchant or equipment link`
                        : 'All deployments have valid links'
                },
                {
                    name: 'Returns without equipment link',
                    status: (orphanReturnsRes.count || 0) > 0 ? 'warn' : 'pass',
                    detail: (orphanReturnsRes.count || 0) > 0
                        ? `${orphanReturnsRes.count} return(s) have no equipment linked`
                        : 'All returns have equipment linked'
                },
                {
                    name: 'Equipment records with null status',
                    status: (nullStatusRes.count || 0) > 0 ? 'warn' : 'pass',
                    detail: (nullStatusRes.count || 0) > 0
                        ? `${nullStatusRes.count} equipment record(s) have no status set`
                        : 'All equipment has a status value'
                },
                {
                    name: 'Equipment status vs. merchant assignment conflicts',
                    status: (equipConflictsRes.data?.length || 0) > 0 ? 'warn' : 'pass',
                    detail: (equipConflictsRes.data?.length || 0) > 0
                        ? `${equipConflictsRes.data.length} conflict(s): stocked units with merchant IDs, or deployed units missing merchant IDs`
                        : 'All equipment statuses match their merchant assignments'
                },
                {
                    name: 'Approved merchants with no agent assigned',
                    status: (merchantsNoAgentRes.count || 0) > 0 ? 'warn' : 'pass',
                    detail: (merchantsNoAgentRes.count || 0) > 0
                        ? `${merchantsNoAgentRes.count} approved merchant(s) have no agent_id — they won't appear in partner portfolios`
                        : 'All approved merchants have an agent assigned'
                }
            ];

            sections.push({
                title: 'Data Integrity',
                icon: 'storage',
                status: integrityChecks.some(c => c.status === 'fail') ? 'fail' : integrityChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: integrityChecks
            });

            // ── 8. AI & Jarvis Health ─────────────────────────────────────────
            const [knowledgeCountRes, chatHistoryCountRes, knowledgeSourcesRes] = await Promise.all([
                safeQuery(() => supabase.from('jarvis_knowledge').select('*', { count: 'exact', head: true })),
                safeQuery(() => supabase.from('chat_history').select('*', { count: 'exact', head: true }).lt('created_at', since30d)),
                safeQuery(() => supabase.from('jarvis_knowledge').select('source').limit(100))
            ]);

            const knowledgeCount = knowledgeCountRes.count || 0;
            const oldChatRows = chatHistoryCountRes.count || 0;
            const sources = knowledgeSourcesRes.data || [];
            const sourceBreakdown = sources.reduce((acc, r) => { acc[r.source] = (acc[r.source] || 0) + 1; return acc; }, {});
            const sourceStr = Object.entries(sourceBreakdown).map(([k, v]) => `${k}: ${v}`).join(', ');

            const aiChecks = [
                {
                    name: 'Gemini API Key configured',
                    status: process.env.GEMINI_API_KEY ? 'pass' : 'fail',
                    detail: process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY is present — Jarvis AI is operational' : 'GEMINI_API_KEY is missing — Jarvis will not function'
                },
                {
                    name: 'Jarvis knowledge base populated',
                    status: knowledgeCount === 0 ? 'warn' : knowledgeCount < 5 ? 'warn' : 'pass',
                    detail: knowledgeCount === 0
                        ? 'Knowledge base is empty — Jarvis has no custom business knowledge. Add entries in the Brain Manager.'
                        : `${knowledgeCount} knowledge entry(ies) loaded. Sources: ${sourceStr || 'unknown'}`
                },
                {
                    name: 'Chat history accumulation (rows older than 30 days)',
                    status: oldChatRows > 500 ? 'warn' : 'pass',
                    detail: oldChatRows > 500
                        ? `${oldChatRows} old chat history rows (30+ days) — consider scheduling cleanup to keep the table lean`
                        : `${oldChatRows} old chat history row(s) — within acceptable range`
                }
            ];

            sections.push({
                title: 'AI & Jarvis Health',
                icon: 'psychology',
                status: aiChecks.some(c => c.status === 'fail') ? 'fail' : aiChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: aiChecks
            });

            // ── 9. Operational Health ─────────────────────────────────────────
            const [stalledTicketsRes, oldOpenRmasRes, stuckTransitRes,
                   oldPendingIdeasRes, notifBacklogRes] = await Promise.all([
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
                ),
                safeQuery(() =>
                    supabase.from('feature_ideas')
                        .select('title', { count: 'exact' })
                        .eq('status', 'pending')
                        .lt('created_at', since60d)
                        .limit(5)
                ),
                safeQuery(() =>
                    supabase.from('notifications')
                        .select('*', { count: 'exact', head: true })
                        .eq('is_read', false)
                        .eq('recipient_type', 'staff')
                        .lt('created_at', since30d)
                )
            ]);

            const stalledTickets = stalledTicketsRes.data || [];
            const oldOpenRmas = oldOpenRmasRes.data || [];
            const stuckTransit = stuckTransitRes.data || [];
            const oldPendingIdeas = oldPendingIdeasRes.data || [];
            const notifBacklog = notifBacklogRes.count || 0;

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
                },
                {
                    name: 'Feature ideas pending for 60+ days with no action',
                    status: oldPendingIdeas.length > 0 ? 'warn' : 'pass',
                    detail: oldPendingIdeas.length > 0
                        ? `${oldPendingIdeas.length} idea(s) ignored for 60+ days: ${oldPendingIdeas.map(i => `"${i.title}"`).join(', ')} — review in the Ideas board`
                        : 'No long-neglected feature requests'
                },
                {
                    name: 'Unread staff notifications older than 30 days',
                    status: notifBacklog > 20 ? 'warn' : 'pass',
                    detail: notifBacklog > 20
                        ? `${notifBacklog} unread staff notification(s) older than 30 days — users may not be checking their notifications`
                        : `${notifBacklog} old unread staff notification(s) — within normal range`
                }
            ];

            sections.push({
                title: 'Operational Health',
                icon: 'monitor_heart',
                status: opChecks.some(c => c.status === 'fail') ? 'fail' : opChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: opChecks
            });

            // ── 10. Penetration & API Security ────────────────────────────────
            const [anonSessionsRes, suspiciousLogsRes, longPendingPasswordsRes] = await Promise.all([
                // Partner sessions created without a valid person reference
                safeQuery(() => supabase.rpc('get_orphan_partner_sessions')),
                // Activity logs showing admin actions by non-admin emails
                safeQuery(() =>
                    supabase.from('activity_logs')
                        .select('email, action, created_at')
                        .ilike('action', '%admin%')
                        .gte('created_at', since7d)
                        .limit(20)
                ),
                // Users with invitation tokens not cleared after 30 days (unaccepted invites)
                safeQuery(() =>
                    supabase.from('app_users')
                        .select('email, created_at', { count: 'exact' })
                        .not('invitation_token', 'is', null)
                        .eq('portal_password_set', false)
                        .lt('created_at', since30d)
                        .limit(10)
                )
            ]);

            const penChecks = [];

            const orphanSessions = anonSessionsRes.data || [];
            penChecks.push({
                name: 'Orphan partner sessions (no valid person)',
                status: orphanSessions.length > 0 ? 'fail' : 'pass',
                detail: orphanSessions.length > 0
                    ? `ALERT: ${orphanSessions.length} session(s) with no linked person record — possible spoofed token(s)`
                    : 'All active partner sessions have valid person references'
            });

            const suspiciousLogs = suspiciousLogsRes.data || [];
            const uniqueSuspicious = [...new Set(suspiciousLogs.map(l => l.email))];
            penChecks.push({
                name: 'Admin-action activity by external emails (7d)',
                status: uniqueSuspicious.length > 0 ? 'warn' : 'pass',
                detail: uniqueSuspicious.length > 0
                    ? `Admin-tagged actions from ${uniqueSuspicious.length} email(s) in past 7 days — verify these are expected: ${uniqueSuspicious.join(', ')}`
                    : 'No unusual admin-action patterns in activity logs'
            });

            const stalePendingInvites = longPendingPasswordsRes.data || [];
            penChecks.push({
                name: 'Unaccepted staff invitations older than 30 days',
                status: stalePendingInvites.length > 0 ? 'warn' : 'pass',
                detail: stalePendingInvites.length > 0
                    ? `${stalePendingInvites.length} staff account(s) have active invitation tokens not yet accepted: ${stalePendingInvites.map(u => u.email).join(', ')} — consider revoking and re-inviting`
                    : 'No stale unaccepted staff invitations'
            });

            // Check if SUPABASE_ANON_KEY is also set (needed for some client checks, should not be the service key)
            const hasAnonKey = !!process.env.SUPABASE_ANON_KEY || !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
            const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
            const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
            const keysAreSame = serviceKey && anonKey && serviceKey === anonKey;

            penChecks.push({
                name: 'Service role key ≠ anon key (key separation)',
                status: keysAreSame ? 'fail' : 'pass',
                detail: keysAreSame
                    ? 'CRITICAL: Service role key and anon key are identical — the service key must never be exposed to the client'
                    : 'Service role key and anon key are distinct — correct separation'
            });

            sections.push({
                title: 'Penetration & API Security',
                icon: 'bug_report',
                status: penChecks.some(c => c.status === 'fail') ? 'fail' : penChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: penChecks
            });

            // ── 11. Secrets & Key Rotation ────────────────────────────────────
            const [appConfigAgeRes, apiKeysAgeRes] = await Promise.all([
                safeQuery(() => supabase.from('app_config').select('key, updated_at').order('updated_at')),
                safeQuery(() => supabase.from('api_keys').select('id, name, created_at, last_rotated_at, is_active').eq('is_active', true).limit(50))
            ]);

            const configKeys = appConfigAgeRes.data || [];
            const ROTATE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;
            const staleConfigKeys = configKeys.filter(k =>
                k.updated_at && (Date.now() - new Date(k.updated_at).getTime()) > ROTATE_THRESHOLD_MS
            );
            const criticalConfigKeys = ['GHL_API_KEY', 'GHL_LOCATION_ID', 'POSTMARK_SERVER_TOKEN'];
            const missingConfigKeys = criticalConfigKeys.filter(k => !configKeys.find(c => c.key === k));

            const apiKeysList = apiKeysAgeRes.data || [];
            const staleApiKeys = apiKeysList.filter(k => {
                const ref = k.last_rotated_at || k.created_at;
                return ref && (Date.now() - new Date(ref).getTime()) > ROTATE_THRESHOLD_MS;
            });

            const hasCronSecret = !!process.env.CRON_SECRET;

            const secretsChecks = [];

            secretsChecks.push({
                name: 'App config secrets not rotated in 90+ days',
                status: staleConfigKeys.length > 0 ? 'warn' : missingConfigKeys.length > 0 ? 'fail' : 'pass',
                detail: missingConfigKeys.length > 0
                    ? `MISSING critical config: ${missingConfigKeys.join(', ')} — related features will fail`
                    : staleConfigKeys.length > 0
                        ? `${staleConfigKeys.length} secret(s) not rotated in 90+ days: ${staleConfigKeys.map(k => k.key).join(', ')} — rotation recommended`
                        : `All ${configKeys.length} configured secret(s) are within the 90-day rotation window`
            });

            secretsChecks.push({
                name: 'Cron endpoint secret (CRON_SECRET)',
                status: hasCronSecret ? 'pass' : 'warn',
                detail: hasCronSecret
                    ? 'CRON_SECRET is set — cron endpoints are protected from unauthorized calls'
                    : 'CRON_SECRET is not set — cron endpoints can be triggered by anyone with the URL'
            });

            secretsChecks.push({
                name: 'Active API keys not rotated in 90+ days',
                status: staleApiKeys.length > 3 ? 'fail' : staleApiKeys.length > 0 ? 'warn' : 'pass',
                detail: staleApiKeys.length > 0
                    ? `${staleApiKeys.length} active API key(s) older than 90 days without rotation: ${staleApiKeys.map(k => k.name || k.id.slice(0, 8) + '...').join(', ')}`
                    : `All ${apiKeysList.length} active API key(s) are within rotation policy`
            });

            sections.push({
                title: 'Secrets & Key Rotation',
                icon: 'vpn_key',
                status: secretsChecks.some(c => c.status === 'fail') ? 'fail' : secretsChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: secretsChecks
            });

            // ── 12. Trusted Device Security ───────────────────────────────────
            const now2 = new Date();
            const [trustedDevicesRes, expiredDevicesRes] = await Promise.all([
                safeQuery(() => supabase.from('trusted_devices').select('userid, created_at, last_used, expires_at')),
                safeQuery(() =>
                    supabase.from('trusted_devices')
                        .select('*', { count: 'exact', head: true })
                        .lt('expires_at', now2.toISOString())
                )
            ]);

            const allTrusted = trustedDevicesRes.data || [];
            const expiredCount = expiredDevicesRes.count || 0;

            // Group by user to detect excessive device counts
            const devicesByUser = {};
            allTrusted.forEach(d => { devicesByUser[d.userid] = (devicesByUser[d.userid] || 0) + 1; });
            const overloadedUsers = Object.entries(devicesByUser).filter(([, c]) => c >= 5);

            // Stale trusted devices — last_used > 90 days ago
            const staleDevices = allTrusted.filter(d =>
                d.last_used && (Date.now() - new Date(d.last_used).getTime()) > ROTATE_THRESHOLD_MS
            );

            // Devices expiring within 7 days
            const expiringDevices = allTrusted.filter(d =>
                d.expires_at &&
                new Date(d.expires_at) > now2 &&
                (new Date(d.expires_at).getTime() - Date.now()) < 7 * 24 * 60 * 60 * 1000
            );

            const deviceChecks = [
                {
                    name: 'Expired trusted devices not cleaned up',
                    status: expiredCount > 20 ? 'warn' : 'pass',
                    detail: expiredCount > 0
                        ? `${expiredCount} expired trusted device token(s) still in database — consider purging`
                        : 'No expired trusted device records found'
                },
                {
                    name: 'Users with 5+ trusted devices (possible token hoarding)',
                    status: overloadedUsers.length > 0 ? 'warn' : 'pass',
                    detail: overloadedUsers.length > 0
                        ? `${overloadedUsers.length} user(s) have ≥5 trusted devices: ${overloadedUsers.map(([uid, c]) => `${uid.slice(0, 8)}... (${c})`).join(', ')} — review for account sharing`
                        : `All users have fewer than 5 trusted devices — within normal range`
                },
                {
                    name: 'Trusted devices inactive for 90+ days',
                    status: staleDevices.length > 5 ? 'warn' : 'pass',
                    detail: staleDevices.length > 0
                        ? `${staleDevices.length} device(s) not seen in 90+ days — consider revoking stale trust tokens`
                        : 'All trusted devices have recent activity'
                },
                {
                    name: 'Total trusted device tokens in circulation',
                    status: 'info',
                    detail: `${allTrusted.length} total trusted device token(s) across all users (${expiredCount} expired, ${expiringDevices.length} expiring within 7 days)`
                }
            ];

            sections.push({
                title: 'Trusted Device Security',
                icon: 'devices',
                status: deviceChecks.some(c => c.status === 'fail') ? 'fail' : deviceChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: deviceChecks
            });

            // ── 13. Webhook & Integration Security ────────────────────────────
            const [webhookEndpointsRes, failedWebhooksRes, staleWebhooksRes] = await Promise.all([
                safeQuery(() => supabase.from('webhook_endpoints')
                    .select('id, label, url, secret, is_active, last_triggered_at, last_status, created_at')
                    .eq('is_active', true)
                ),
                safeQuery(() => supabase.from('webhook_delivery_log')
                    .select('*', { count: 'exact', head: true })
                    .eq('success', false)
                    .gte('created_at', since24h)
                ),
                safeQuery(() => supabase.from('webhook_delivery_log')
                    .select('*', { count: 'exact', head: true })
                    .eq('success', false)
                    .gte('created_at', since7d)
                )
            ]);

            const activeEndpoints = webhookEndpointsRes.data || [];
            const endpointsNoSecret = activeEndpoints.filter(e => !e.secret || e.secret.length < 8);
            const failedLast24h = failedWebhooksRes.count || 0;
            const failedLast7d = staleWebhooksRes.count || 0;

            // Endpoints not triggered in 30+ days (dormant)
            const dormantEndpoints = activeEndpoints.filter(e =>
                e.last_triggered_at && (Date.now() - new Date(e.last_triggered_at).getTime()) > 30 * 24 * 60 * 60 * 1000
            );
            const neverTriggered = activeEndpoints.filter(e => !e.last_triggered_at);

            // Endpoints with last_status indicating errors (4xx/5xx)
            const errorEndpoints = activeEndpoints.filter(e => e.last_status && e.last_status >= 400);

            const webhookChecks = [
                {
                    name: 'Active webhook endpoints without a signing secret',
                    status: endpointsNoSecret.length > 0 ? 'fail' : 'pass',
                    detail: endpointsNoSecret.length > 0
                        ? `CRITICAL: ${endpointsNoSecret.length} active webhook(s) have no signing secret — payloads cannot be verified: ${endpointsNoSecret.map(e => e.label || e.url.slice(0, 40)).join(', ')}`
                        : `All ${activeEndpoints.length} active webhook endpoint(s) have signing secrets configured`
                },
                {
                    name: 'Failed webhook deliveries (last 24h)',
                    status: failedLast24h > 10 ? 'fail' : failedLast24h > 0 ? 'warn' : 'pass',
                    detail: failedLast24h > 0
                        ? `${failedLast24h} failed delivery attempt(s) in the last 24 hours (${failedLast7d} in the last 7 days) — check endpoint availability`
                        : 'All webhook deliveries in the last 24 hours succeeded'
                },
                {
                    name: 'Active webhooks with error response codes',
                    status: errorEndpoints.length > 0 ? 'warn' : 'pass',
                    detail: errorEndpoints.length > 0
                        ? `${errorEndpoints.length} active endpoint(s) last returned HTTP ${errorEndpoints.map(e => e.last_status).join('/')} errors: ${errorEndpoints.map(e => e.label || e.id.slice(0, 8)).join(', ')}`
                        : 'All active webhook endpoints are responding successfully'
                },
                {
                    name: 'Dormant or never-triggered active webhooks',
                    status: (dormantEndpoints.length + neverTriggered.length) > 0 ? 'warn' : 'pass',
                    detail: (dormantEndpoints.length + neverTriggered.length) > 0
                        ? `${dormantEndpoints.length} endpoint(s) dormant 30+ days, ${neverTriggered.length} never triggered — consider disabling unused endpoints`
                        : 'All active webhook endpoints have recent delivery activity'
                }
            ];

            sections.push({
                title: 'Webhook & Integration Security',
                icon: 'webhook',
                status: webhookChecks.some(c => c.status === 'fail') ? 'fail' : webhookChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: webhookChecks
            });

            // ── 14. Anomalous Activity Detection ──────────────────────────────
            const [recentLoginsRes, adminActionsRes, apiAbuseRes] = await Promise.all([
                // All successful logins in last 24h with IP
                safeQuery(() => supabase.from('activity_logs')
                    .select('email, ip_address, created_at')
                    .eq('status', 'SUCCESS')
                    .gte('created_at', since24h)
                    .not('ip_address', 'is', null)
                    .limit(1000)
                ),
                // All admin/security category actions in last 7 days
                safeQuery(() => supabase.from('activity_logs')
                    .select('email, action, created_at, ip_address')
                    .in('category', ['admin', 'security', 'staff'])
                    .gte('created_at', since7d)
                    .order('created_at', { ascending: false })
                    .limit(500)
                ),
                // API usage in last 24h grouped by key
                safeQuery(() => supabase.from('api_usage_log')
                    .select('api_key_id, ip_address, status_code')
                    .gte('created_at', since24h)
                    .limit(5000)
                )
            ]);

            const anomalyChecks = [];

            // Multi-IP logins: same email from 3+ distinct IPs in 24h
            const ipsByEmail = {};
            (recentLoginsRes.data || []).forEach(l => {
                if (!ipsByEmail[l.email]) ipsByEmail[l.email] = new Set();
                if (l.ip_address) ipsByEmail[l.email].add(l.ip_address);
            });
            const multiIpUsers = Object.entries(ipsByEmail)
                .filter(([, ips]) => ips.size >= 3)
                .map(([email, ips]) => ({ email, count: ips.size }));

            anomalyChecks.push({
                name: 'Logins from 3+ distinct IPs per user (24h)',
                status: multiIpUsers.length > 0 ? 'warn' : 'pass',
                detail: multiIpUsers.length > 0
                    ? `${multiIpUsers.length} user(s) logged in from 3+ different IP addresses in 24h — possible credential sharing or account takeover: ${multiIpUsers.map(u => `${u.email} (${u.count} IPs)`).join(', ')}`
                    : 'No users with suspicious multi-IP login patterns in the last 24 hours'
            });

            // Off-hours admin actions: genuine overnight (12–5 AM) in the BUSINESS
            // timezone, not UTC — otherwise normal US-evening work looks suspicious.
            const BUSINESS_TZ = 'America/New_York';
            const hourInTz = (iso) => {
                let h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, hour: '2-digit', hour12: false }).format(new Date(iso)), 10);
                return h % 24; // some locales render midnight as 24
            };
            const adminActions = adminActionsRes.data || [];
            const offHoursActions = adminActions.filter(a => {
                const h = hourInTz(a.created_at);
                return h >= 0 && h < 5;
            });
            const offHoursActors = [...new Set(offHoursActions.map(a => a.email))];

            anomalyChecks.push({
                name: 'Admin/security actions between 12–5 AM (business time, 7d)',
                status: offHoursActions.length > 10 ? 'warn' : 'pass',
                detail: offHoursActions.length > 0
                    ? `${offHoursActions.length} admin action(s) in the overnight window (12–5 AM ${BUSINESS_TZ}) by: ${offHoursActors.join(', ')} — verify these are expected`
                    : 'No admin actions in the overnight (12–5 AM) window'
            });

            // API abuse: single API key making 500+ calls in 24h
            const apiCalls = apiAbuseRes.data || [];
            const callsByKey = {};
            const errorsByKey = {};
            apiCalls.forEach(r => {
                const key = r.api_key_id || r.ip_address || 'unknown';
                callsByKey[key] = (callsByKey[key] || 0) + 1;
                if (r.status_code && r.status_code >= 400) errorsByKey[key] = (errorsByKey[key] || 0) + 1;
            });
            const highVolumeKeys = Object.entries(callsByKey).filter(([, c]) => c >= 500).map(([k, c]) => `${k.slice(0, 8)}... (${c} calls)`);
            const highErrorKeys = Object.entries(errorsByKey).filter(([, c]) => c >= 50).map(([k, c]) => `${k.slice(0, 8)}... (${c} errors)`);

            anomalyChecks.push({
                name: 'API keys with 500+ calls in 24h (abuse threshold)',
                status: highVolumeKeys.length > 0 ? 'warn' : 'pass',
                detail: highVolumeKeys.length > 0
                    ? `High-volume API keys detected: ${highVolumeKeys.join(', ')} — review if this is expected usage or a scraping attempt`
                    : `${apiCalls.length} API call(s) logged in 24h — no single key exceeds 500 calls`
            });

            anomalyChecks.push({
                name: 'API keys with 50+ error responses in 24h',
                status: highErrorKeys.length > 0 ? 'warn' : 'pass',
                detail: highErrorKeys.length > 0
                    ? `Keys generating excessive errors: ${highErrorKeys.join(', ')} — may indicate misconfigured clients or probing`
                    : 'No API keys generating excessive error responses'
            });

            // Activity log coverage — check the log isn't silent (should have entries in last 24h if system is active)
            const recentLogCount = (recentLoginsRes.data || []).length;
            anomalyChecks.push({
                name: 'Activity log coverage (audit trail health)',
                status: recentLogCount === 0 ? 'warn' : 'pass',
                detail: recentLogCount === 0
                    ? 'No activity log entries in the last 24 hours — audit trail may be broken or system is completely idle'
                    : `${recentLogCount} activity log entries in the last 24 hours — audit trail is active`
            });

            sections.push({
                title: 'Anomalous Activity Detection',
                icon: 'crisis_alert',
                status: anomalyChecks.some(c => c.status === 'fail') ? 'fail' : anomalyChecks.some(c => c.status === 'warn') ? 'warn' : 'pass',
                checks: anomalyChecks
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

            // ── Send email report ─────────────────────────────────────────────
            const { data: emailList } = await supabase.from('security_check_emails').select('email');
            if (emailList?.length && process.env.POSTMARK_SERVER_TOKEN) {
                const statusIcon  = overall === 'pass' ? '✅' : overall === 'warn' ? '⚠️' : '❌';
                const statusLabel = overall === 'pass' ? 'All Clear' : overall === 'warn' ? 'Warnings Found' : 'Issues Detected';
                const statusColor = overall === 'pass' ? '#166534' : overall === 'warn' ? '#92400e' : '#991b1b';
                const statusBg    = overall === 'pass' ? '#dcfce7' : overall === 'warn' ? '#fef3c7' : '#fee2e2';

                const sectionHtml = sections.map(s => {
                    const sColor = s.status === 'pass' ? '#166534' : s.status === 'warn' ? '#92400e' : s.status === 'fail' ? '#991b1b' : '#1e3a5f';
                    const sBg    = s.status === 'pass' ? '#dcfce7' : s.status === 'warn' ? '#fef3c7' : s.status === 'fail' ? '#fee2e2' : '#eff6ff';
                    const checksHtml = s.checks.map(c => {
                        const icon = c.status === 'pass' ? '✅' : c.status === 'warn' ? '⚠️' : c.status === 'fail' ? '❌' : 'ℹ️';
                        return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${icon} <strong>${c.name}</strong><div style="font-size:12px;color:#64748b;margin-top:2px;">${c.detail}</div></td></tr>`;
                    }).join('');
                    return `<div style="margin-bottom:20px;">
                        <div style="background:${sBg};color:${sColor};padding:8px 14px;border-radius:6px 6px 0 0;font-weight:700;font-size:13px;">${s.title}</div>
                        <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-top:none;">${checksHtml}</table>
                    </div>`;
                }).join('');

                const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:40px 20px;">
                    <h2 style="color:#004990;margin:0 0 20px;">PayProTec Security Check</h2>
                    <div style="background:${statusBg};color:${statusColor};padding:16px 20px;border-radius:10px;margin-bottom:24px;font-size:16px;font-weight:700;">
                        ${statusIcon} ${statusLabel}
                        <div style="font-size:12px;font-weight:400;margin-top:4px;opacity:0.8;">Run at ${new Date().toLocaleString()} · ${sections.length} sections checked</div>
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
                            TextBody: `Security Check: ${statusLabel}. Run at ${new Date().toLocaleString()}. ${sections.length} sections checked.`,
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
