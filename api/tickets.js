import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body;

    try {

        // Validate partner session helper
        async function validatePartner(token) {
            if (!token) return null;
            const { data } = await supabase.from('partner_sessions')
                .select('person_id, expires_at').eq('session_token', token).single();
            if (!data || new Date(data.expires_at) < new Date()) return null;
            return data.person_id;
        }

        if (action === 'create') {
            const { token, merchant_id, type, category, subject, description, priority } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            if (!type || !subject) return res.status(400).json({ success: false, message: 'Type and subject are required.' });

            // If merchant_id provided, verify this partner owns the merchant
            if (merchant_id) {
                const { data: person } = await supabase.from('persons').select('id').eq('id', personId).single();
                if (!person) return res.status(401).json({ success: false, message: 'Partner not found.' });
            }

            const { data: ticket, error } = await supabase.from('support_tickets').insert({
                person_id: personId,
                merchant_id: merchant_id || null,
                type,
                category: category || null,
                subject,
                description: description || null,
                priority: priority || 'normal'
            }).select('id, ticket_number, status, created_at').single();

            if (error) throw error;
            return res.status(200).json({ success: true, ticket });
        }

        if (action === 'list_for_partner') {
            const { token } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { data, error } = await supabase.from('support_tickets')
                .select('id, ticket_number, type, category, subject, status, priority, created_at, updated_at, merchant_id, merchants:merchant_id(dba_name)')
                .eq('person_id', personId)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'list_for_staff') {
            const { status, type, limit = 50 } = req.body;
            let query = supabase.from('support_tickets')
                .select('id, ticket_number, type, category, subject, status, priority, assigned_to, created_at, updated_at, merchant_id, person_id, merchants:merchant_id(dba_name), persons:person_id(full_name, email)')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (status && status !== 'all') query = query.eq('status', status);
            if (type && type !== 'all') query = query.eq('type', type);

            const { data, error } = await query;
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'get_detail') {
            const { ticket_id, token } = req.body;
            const { data: ticket, error } = await supabase.from('support_tickets')
                .select('*, merchants:merchant_id(dba_name, merchant_id, merchant_city, merchant_state, merchant_phone), persons:person_id(full_name, email, phone_number)')
                .eq('id', ticket_id)
                .single();

            if (error || !ticket) return res.status(404).json({ success: false, message: 'Ticket not found.' });

            // If partner token provided, verify ownership
            if (token) {
                const personId = await validatePartner(token);
                if (!personId || ticket.person_id !== personId)
                    return res.status(403).json({ success: false, message: 'Access denied.' });
            }

            return res.status(200).json({ success: true, ticket });
        }

        if (action === 'update_status') {
            const { ticket_id, status, assigned_to, staff_notes, priority } = req.body;
            if (!ticket_id) return res.status(400).json({ success: false, message: 'ticket_id required.' });

            const updates = {};
            if (status) updates.status = status;
            if (assigned_to !== undefined) updates.assigned_to = assigned_to;
            if (staff_notes !== undefined) updates.staff_notes = staff_notes;
            if (priority) updates.priority = priority;

            const { error } = await supabase.from('support_tickets').update(updates).eq('id', ticket_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });

    } catch (err) {
        console.error('Tickets Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
