import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, userid } = req.body;
    if (!userid) return res.status(400).json({ success: false, message: 'userid required' });

    if (action === 'get_counts') {
        async function count(table, filter) {
            try {
                let q = supabase.from(table).select('*', { count: 'exact', head: true });
                q = filter(q);
                const { count: n } = await q;
                return n || 0;
            } catch { return 0; }
        }

        const [tickets, returns_, deployments, tasks, ideas] = await Promise.all([
            // Tickets: open/in_progress where partner has replied (needs staff attention)
            count('support_tickets', q =>
                q.in('status', ['open', 'in_progress', 'pending_partner'])
                 .gt('unread_count', 0)
            ),
            // Returns: currently open
            count('returns', q => q.eq('status', 'Open')),
            // Deployments: pending
            count('deployments', q => q.eq('status', 'Pending')),
            // Tasks: pending and assigned to this user
            count('merchant_tasks', q =>
                q.eq('assigned_to', userid).eq('status', 'Pending')
            ),
            // Ideas: open/pending — awaiting staff review
            count('feature_ideas', q =>
                q.not('status', 'in', '(Done,Closed,Rejected)')
            ),
        ]);

        return res.status(200).json({
            success: true,
            counts: {
                partners: 0,
                merchants: 0,
                inventory: 0,
                deployments,
                returns: returns_,
                tickets,
                tasks,
                ideas,
            }
        });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
}
