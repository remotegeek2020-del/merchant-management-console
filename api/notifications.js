import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { last_seen = {}, userid } = req.body;

    // Default: 24h ago for any section not previously visited
    const fallback = new Date(Date.now() - 86400000).toISOString();

    function since(key) {
        return last_seen[key] || fallback;
    }

    async function count(table, timestampCol, since, extraFilters) {
        try {
            let q = supabase.from(table).select('*', { count: 'exact', head: true }).gte(timestampCol, since);
            if (extraFilters) q = extraFilters(q);
            const { count: n } = await q;
            return n || 0;
        } catch { return 0; }
    }

    const [partners, deployments, returns_, inventory, merchants, tickets, tasks, ideas] = await Promise.all([
        count('persons',          'enrolled_at',   since('partners')),
        count('deployments',      'created_at',    since('deployments')),
        count('returns',          'created_at',    since('returns')),
        count('equipments',       'created_at',    since('inventory')),
        count('merchants',        'enrollment_date', since('merchants')),
        count('support_tickets',  'created_at',    since('tickets')),
        count('merchant_tasks',   'created_at',    since('tasks'),
            q => userid ? q.eq('assigned_to', userid) : q),
        count('feature_ideas',    'created_at',    since('ideas')),
    ]);

    return res.status(200).json({
        success: true,
        counts: { partners, deployments, returns: returns_, inventory, merchants, tickets, tasks, ideas }
    });
}
