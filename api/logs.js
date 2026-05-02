import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
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
        return res.status(200).json({ success: true, data, count, page: parseInt(page), total_pages: Math.ceil((count||0) / parseInt(limit)) });
    }

    // ── WRITE LOG ─────────────────────────────────────────
    if (req.method === 'POST') {
        const { email, action, status, category = 'general', target_id, target_type, severity = 'info', old_value, new_value } = req.body;

        const { error } = await supabase.from('activity_logs').insert([{
            email: email || 'System',
            action,
            status: status || 'success',
            category,
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
