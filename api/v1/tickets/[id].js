import { createClient } from '@supabase/supabase-js';
import { validateApiKey } from '../_auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'GET') return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this endpoint.' } });

    const ctx = await validateApiKey(req, res);
    if (!ctx) return;

    const { id } = req.query;
    if (!id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'Ticket ID required in path.' } });

    // Accept either numeric id or ticket_number string
    const isNumeric = /^\d+$/.test(id);
    const lookupField = isNumeric ? 'id' : 'ticket_number';

    const { data: ticket, error } = await supabase.from('support_tickets')
        .select('*, merchants:merchant_id(dba_name, merchant_id, merchant_city, merchant_state)')
        .eq(lookupField, id)
        .maybeSingle();

    if (error || !ticket) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Ticket not found.' } });
    if (ticket.person_id !== ctx.owner_id) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'This ticket does not belong to your account.' } });

    // Fetch comments (exclude internal staff notes)
    const { data: comments } = await supabase.from('ticket_comments')
        .select('id, author_type, author_name, body, change_summary, created_at')
        .eq('ticket_id', ticket.id)
        .eq('is_internal', false)
        .order('created_at', { ascending: true });

    // Reset partner unread badge (fire-and-forget)
    supabase.from('support_tickets').update({ partner_unread_count: 0 }).eq('id', ticket.id).then(() => {});

    return res.json({
        success: true,
        data: { ...ticket, comments: comments || [] }
    });
}
