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
        const { email, action, status, category = 'general', target_id, target_type, severity = 'info', old_value, new_value } = req.body;

        const { error } = await supabase.from('activity_logs').insert([{
            email: email || 'System',
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
