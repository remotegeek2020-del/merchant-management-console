import { createClient } from '@supabase/supabase-js';
import { validateApiKey } from './_auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function genTicketId() {
    const ym = new Date().toISOString().slice(0, 7).replace('-', '');
    return `TKT-${ym}-${Math.floor(Math.random() * 99999 + 1).toString().padStart(5, '0')}`;
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    const ctx = await validateApiKey(req, res);
    if (!ctx) return;

    // ── GET: list tickets ─────────────────────────────────
    if (req.method === 'GET') {
        const page   = Math.max(0, parseInt(req.query.page   || '0'));
        const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit  || '25')));
        const status = (req.query.status || '').trim();
        const type   = (req.query.type   || '').trim();

        let query = supabase.from('support_tickets')
            .select('id, ticket_number, type, category, subject, status, priority, partner_unread_count, created_at, updated_at, merchants:merchant_id(dba_name)', { count: 'exact' })
            .eq('person_id', ctx.owner_id)
            .order('created_at', { ascending: false })
            .range(page * limit, (page + 1) * limit - 1);

        if (status) query = query.eq('status', status);
        if (type)   query = query.eq('type', type);

        const { data, count, error } = await query;
        if (error) return res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });

        return res.json({
            success: true,
            data: data || [],
            meta: { page, limit, total: count || 0, has_more: (page + 1) * limit < (count || 0) }
        });
    }

    // ── POST: create ticket ───────────────────────────────
    if (req.method === 'POST') {
        const { subject, description, type = 'general', category = 'other', priority = 'medium', merchant_id } = req.body || {};

        if (!subject?.trim()) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'subject is required.' } });
        if (!description?.trim()) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'description is required.' } });

        const VALID_TYPES = ['general', 'equipment', 'billing', 'rma', 'deployment', 'other'];
        const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
        if (!VALID_TYPES.includes(type)) return res.status(400).json({ success: false, error: { code: 'INVALID_PARAM', message: `type must be one of: ${VALID_TYPES.join(', ')}` } });
        if (!VALID_PRIORITIES.includes(priority)) return res.status(400).json({ success: false, error: { code: 'INVALID_PARAM', message: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` } });

        // Resolve merchant UUID if merchant_id provided
        let merchantUuid = null;
        if (merchant_id) {
            const isUuid = /^[0-9a-f-]{36}$/i.test(merchant_id);
            const { data: m } = await supabase.from('merchants').select('id').eq(isUuid ? 'id' : 'merchant_id', merchant_id).maybeSingle();
            if (m) merchantUuid = m.id;
        }

        const ticketNumber = genTicketId();
        const { data: ticket, error } = await supabase.from('support_tickets').insert({
            ticket_number: ticketNumber,
            person_id: ctx.owner_id,
            merchant_id: merchantUuid,
            subject: subject.trim(),
            description: description.trim(),
            type,
            category,
            priority,
            status: 'open',
            source: 'api'
        }).select('id, ticket_number, subject, type, category, priority, status, created_at').single();

        if (error) return res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });

        // Log creation
        await supabase.from('ticket_comments').insert({
            ticket_id: ticket.id,
            author_type: 'system',
            author_name: 'API',
            change_summary: 'Ticket created via API',
            is_internal: true
        });

        return res.status(201).json({ success: true, data: ticket });
    }

    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET to list or POST to create.' } });
}
