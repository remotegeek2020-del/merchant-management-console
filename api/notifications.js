import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const VALID_SECTIONS = ['returns', 'deployments', 'tickets', 'tasks', 'ideas', 'partners', 'merchants', 'inventory'];

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, userid, section } = req.body;
    if (!userid) return res.status(400).json({ success: false, message: 'userid required' });

    // ── MARK SECTION SEEN ────────────────────────────────────────────────────
    if (action === 'mark_seen') {
        if (!section || !VALID_SECTIONS.includes(section)) {
            return res.status(400).json({ success: false, message: 'Invalid section' });
        }
        await supabase.from('user_section_seen').upsert(
            { userid, section, last_seen_at: new Date().toISOString() },
            { onConflict: 'userid,section' }
        );
        return res.status(200).json({ success: true });
    }

    // ── GET COUNTS ───────────────────────────────────────────────────────────
    if (action === 'get_counts') {
        // Load last_seen timestamps for this user
        const { data: seenRows } = await supabase
            .from('user_section_seen')
            .select('section, last_seen_at')
            .eq('userid', userid);

        const seenMap = {};
        (seenRows || []).forEach(r => { seenMap[r.section] = r.last_seen_at; });

        // Default: show items from the last 24 hours if section was never visited
        const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        function since(s) { return seenMap[s] || fallback; }

        async function countNew(table, dateCol, sinceISO, extraFilter) {
            try {
                let q = supabase.from(table)
                    .select('*', { count: 'exact', head: true })
                    .gt(dateCol, sinceISO);
                if (extraFilter) q = extraFilter(q);
                const { count: n } = await q;
                return n || 0;
            } catch { return 0; }
        }

        const [tickets, returns_, deployments, tasks, ideas] = await Promise.all([
            // Tickets: any ticket activity (created or updated) since last visit
            countNew('support_tickets', 'updated_at', since('tickets')),
            // Returns: new returns submitted since last visit
            countNew('returns', 'created_at', since('returns')),
            // Deployments: new deployments since last visit
            countNew('deployments', 'created_at', since('deployments')),
            // Tasks: new tasks assigned to this user since last visit
            countNew('merchant_tasks', 'created_at', since('tasks'), q => q.eq('assigned_to', userid)),
            // Ideas: new ideas since last visit
            countNew('feature_ideas', 'created_at', since('ideas')),
        ]);

        return res.status(200).json({
            success: true,
            counts: { partners: 0, merchants: 0, inventory: 0, deployments, returns: returns_, tickets, tasks, ideas }
        });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
}
