import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function inferCategory(action, provided) {
    if (provided && provided !== 'general') return provided;
    const a = (action || '').toLowerCase();
    if (/login|logout|password|auth|sign.?in|2fa|token/.test(a))           return 'auth';
    if (/merchant|mid|dba/.test(a))                                          return 'merchants';
    if (/deploy/.test(a))                                                    return 'deployments';
    if (/return/.test(a))                                                    return 'returns';
    if (/inventory|equipment|serial|import|stock|unit/.test(a))             return 'inventory';
    if (/task/.test(a))                                                      return 'tasks';
    if (/ticket|support|case/.test(a))                                       return 'tickets';
    if (/user|enroll|activat|deactivat|permission|role|invite/.test(a))     return 'users';
    if (/partner|agent/.test(a))                                             return 'partners';
    return provided || 'general';
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');

    // ── KPI LEADERBOARD (most active users) ───────────────
    if (req.method === 'GET' && req.query.kpi === '1') {
        const days = Math.min(parseInt(req.query.days) || 7, 90);
        const since = new Date(Date.now() - days * 86400000).toISOString();

        // Same excluded-users list as the Activity report
        const { data: exRow } = await supabase.from('app_settings').select('value').eq('key', 'activity_report_excluded_emails').maybeSingle();
        let excluded = []; try { excluded = JSON.parse(exRow?.value || '[]'); } catch { excluded = []; }
        const exSet = new Set((excluded || []).map(e => String(e).toLowerCase()));

        let rows = [], off = 0, done = false;
        while (!done) {
            const { data: batch } = await supabase.from('activity_logs')
                .select('email, category, created_at').gte('created_at', since)
                .order('created_at', { ascending: false }).range(off, off + 999);
            if (!batch || !batch.length) done = true;
            else { rows = rows.concat(batch); off += 1000; if (batch.length < 1000 || off >= 30000) done = true; }
        }

        const byUser = {}, byCat = {};
        let total = 0;
        for (const r of rows) {
            const em = (r.email || '').toLowerCase();
            if (!em || exSet.has(em)) continue;
            byUser[em] = (byUser[em] || 0) + 1;
            const c = r.category || 'other';
            byCat[c] = (byCat[c] || 0) + 1;
            total++;
        }
        const emails = Object.keys(byUser);
        let nameMap = {};
        if (emails.length) {
            const { data: us } = await supabase.from('app_users').select('email, first_name, last_name').in('email', emails);
            (us || []).forEach(u => { nameMap[(u.email || '').toLowerCase()] = `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email; });
        }
        const topUsers = emails.map(em => ({ email: em, name: nameMap[em] || em, count: byUser[em] })).sort((a, b) => b.count - a.count);
        const byCategory = Object.entries(byCat).map(([c, n]) => ({ category: c, count: n })).sort((a, b) => b.count - a.count);
        return res.status(200).json({ success: true, kpi: true, days, totalEvents: total, activeUsers: emails.length, topUsers, byCategory, excluded: [...exSet] });
    }

    // ── GET LOGS ──────────────────────────────────────────
    if (req.method === 'GET') {
        const { page = 0, limit = 50, search = '', category = '', severity = '', from = '', to = '' } = req.query;
        const offset = parseInt(page) * parseInt(limit);

        let query = supabase.from('activity_logs')
            .select('*', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(offset, offset + parseInt(limit) - 1);

        if (search) query = query.or(`email.ilike.%${search}%,action.ilike.%${search}%,status.ilike.%${search}%`);
        if (category) query = query.eq('category', category);
        if (severity) query = query.eq('severity', severity);
        if (from) query = query.gte('created_at', new Date(from).toISOString());
        if (to) query = query.lte('created_at', new Date(to + 'T23:59:59').toISOString());

        const { data, error, count } = await query;
        if (error) return res.status(500).json({ error: error.message });

        // Resolve email/userid → display name from app_users
        let enriched = data || [];
        if (enriched.length) {
            const identifiers = [...new Set(enriched.map(l => l.email).filter(Boolean))];
            const { data: users } = await supabase
                .from('app_users')
                .select('userid, email, first_name, last_name')
                .or(identifiers.map(id => `email.eq.${id},userid.eq.${id}`).join(','));

            const byEmail  = Object.fromEntries((users || []).map(u => [u.email,  u]));
            const byUserid = Object.fromEntries((users || []).map(u => [u.userid, u]));

            enriched = enriched.map(log => {
                const u = byEmail[log.email] || byUserid[log.email];
                return {
                    ...log,
                    user_name: u ? `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email : log.email
                };
            });
        }

        return res.status(200).json({ success: true, data: enriched, count, page: parseInt(page), total_pages: Math.ceil((count||0) / parseInt(limit)) });
    }

    // ── WRITE LOG ─────────────────────────────────────────
    if (req.method === 'POST') {
        const { action, status, category = 'general', target_id, target_type, severity = 'info', old_value, new_value } = req.body;

        // Resolve email from session — never trust client-provided email for audit trails
        const { data: actor } = await supabase
            .from('app_users')
            .select('email')
            .eq('userid', session.userid)
            .single();
        const actorEmail = actor?.email || 'Unknown';

        const { error } = await supabase.from('activity_logs').insert([{
            email: actorEmail,
            action,
            status: status || 'success',
            category: inferCategory(action, category),
            target_id: target_id || null,
            target_type: target_type || null,
            severity,
            old_value: old_value || null,
            new_value: new_value || null,
            user_agent: req.headers['user-agent'],
            ip_address: req.headers['x-forwarded-for'] || 'Internal'
        }]);

        if (error) return res.status(500).json({ success: false, message: error.message });
        return res.status(200).json({ success: true });
    }

    // ── EXPORT CSV ────────────────────────────────────────
    if (req.method === 'PUT') {
        const { search = '', category = '', severity = '', from = '', to = '' } = req.body || {};

        let query = supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(5000);
        if (search) query = query.or(`email.ilike.%${search}%,action.ilike.%${search}%`);
        if (category) query = query.eq('category', category);
        if (severity) query = query.eq('severity', severity);
        if (from) query = query.gte('created_at', new Date(from).toISOString());
        if (to) query = query.lte('created_at', new Date(to + 'T23:59:59').toISOString());

        const { data } = await query;
        return res.status(200).json({ success: true, data: data || [] });
    }

    return res.status(405).json({ success: false, message: 'Method not allowed' });
}
