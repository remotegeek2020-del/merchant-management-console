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
                safeQuery(() => supabase.from('deployments').select('*', { count: 'exact', head: true }).or('merchant_id.is.null,equipment_id.is.null')),
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
