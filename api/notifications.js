import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

const SECTIONS = ['partners', 'merchants', 'inventory', 'deployments', 'returns', 'tickets', 'tasks', 'ideas'];

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, userid, section } = req.body;

    if (!userid) return res.status(400).json({ success: false, message: 'userid required' });

    // Mark a section as seen for this user
    if (action === 'mark_seen') {
        if (!section || !SECTIONS.includes(section)) return res.status(400).json({ success: false });
        await supabase.from('user_section_seen').upsert(
            { userid, section, last_seen_at: new Date().toISOString() },
            { onConflict: 'userid,section' }
        );
        return res.status(200).json({ success: true });
    }

    // Get new-item counts per section for this user
    if (action === 'get_counts') {
        // Load this user's last_seen timestamps from DB
        const { data: seenRows } = await supabase
            .from('user_section_seen')
            .select('section, last_seen_at')
            .eq('userid', userid);

        const seenMap = {};
        (seenRows || []).forEach(r => { seenMap[r.section] = r.last_seen_at; });

        // Baseline: start of today — never show activity older than today
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayISO = todayStart.toISOString();

        // For each section, since = max(last_seen_at, todayStart)
        function since(s) {
            const ls = seenMap[s];
            if (!ls) return todayISO;
            return ls > todayISO ? ls : todayISO;
        }

        async function count(table, col, sinceISO, extra) {
            try {
                let q = supabase.from(table).select('*', { count: 'exact', head: true }).gte(col, sinceISO);
                if (extra) q = extra(q);
                const { count: n } = await q;
                return n || 0;
            } catch { return 0; }
        }

        const [partners, deployments, returns_, inventory, merchants, tickets, tasks, ideas] = await Promise.all([
            count('persons',         'enrolled_at',    since('partners')),
            count('deployments',     'created_at',     since('deployments')),
            count('returns',         'created_at',     since('returns')),
            count('equipments',      'created_at',     since('inventory')),
            count('merchants',       'enrollment_date', since('merchants')),
            count('support_tickets', 'created_at',     since('tickets')),
            count('merchant_tasks',  'created_at',     since('tasks'), q => q.eq('assigned_to', userid)),
            count('feature_ideas',   'created_at',     since('ideas')),
        ]);

        return res.status(200).json({
            success: true,
            counts: { partners, deployments, returns: returns_, inventory, merchants, tickets, tasks, ideas }
        });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
}
