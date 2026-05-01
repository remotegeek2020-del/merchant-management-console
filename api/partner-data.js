import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function validateSession(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).single();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

async function getAgentIds(personId) {
    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    if (!agents?.length) return { agentUuids: [], idStrings: [], identifiers: [] };
    const agentUuids = agents.map(a => a.id);
    const { data: identifiers } = await supabase.from('agent_identifiers').select('id, id_string, rev_share, prime49').in('agent_id', agentUuids);
    return { agentUuids, idStrings: (identifiers || []).map(i => i.id_string), identifiers: identifiers || [] };
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, token } = req.body || {};
    const personId = await validateSession(token);
    if (!personId) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });

    const { agentUuids, idStrings, identifiers } = await getAgentIds(personId);

    try {

        // ── DASHBOARD OVERVIEW ─────────────────────────────
        if (action === 'get_overview') {
            if (!idStrings.length) return res.status(200).json({ success: true, data: { merchants: 0, approved: 0, pending: 0, mtd: 0, vol30: 0, vol90: 0, identifiers: [] } });

            const { data: stats } = await supabase.from('merchant_stats_by_id').select('*').in('agent_id', idStrings);

            let merchants = 0, approved = 0, pending = 0, closed = 0, mtd = 0, vol30 = 0, vol90 = 0;
            (stats || []).forEach(s => {
                approved += parseInt(s.merchant_count || 0);
                pending  += parseInt(s.pending_count || 0);
                closed   += parseInt(s.closed_count || 0);
                mtd      += parseFloat(s.total_volume_sum || 0);
                vol30    += parseFloat(s.total_volume_sum || 0);
                vol90    += parseFloat(s.total_volume_90d_sum || 0);
                merchants += parseInt(s.merchant_count || 0) + parseInt(s.pending_count || 0);
            });

            // Open RMAs for this partner
            const { count: openRmas } = await supabase.from('returns').select('*', { count: 'exact', head: true }).in('merchants.agent_id', idStrings).eq('status', 'Open');

            return res.status(200).json({ success: true, data: { merchants, approved, pending, closed, mtd, vol30, vol90, open_rmas: openRmas || 0, identifiers } });
        }

        // ── MERCHANT LIST ──────────────────────────────────
        if (action === 'get_merchants') {
            const { page = 0, limit = 25, search = '', status_filter = '' } = req.body;
            if (!idStrings.length) return res.status(200).json({ success: true, data: [], count: 0 });

            let query = supabase.from('merchants')
                .select('id, merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_mtd, volume_30_day, volume_90_day, approved_date, email, merchant_phone, merchant_address, merchant_city, merchant_state', { count: 'exact' })
                .in('agent_id', idStrings);

            if (status_filter) query = query.eq('account_status', status_filter);
            if (search) query = query.ilike('dba_name', `%${search}%`);

            const { data, count, error } = await query.range(page * limit, (page + 1) * limit - 1).order('dba_name');
            if (error) throw error;

            // Get identifier details for each merchant
            const enriched = (data || []).map(m => {
                const id = identifiers.find(i => i.id_string === m.agent_id);
                return { ...m, rev_share: id?.rev_share || null, is_prime49: id?.prime49 || false };
            });

            return res.status(200).json({ success: true, data: enriched, count: count || 0 });
        }

        // ── MERCHANT DETAIL ────────────────────────────────
        if (action === 'get_merchant_detail') {
            const { merchant_uuid } = req.body;

            // Verify this merchant belongs to this partner
            const { data: merchant } = await supabase.from('merchants').select('*').eq('id', merchant_uuid).single();
            if (!merchant || !idStrings.includes(merchant.agent_id)) {
                return res.status(403).json({ success: false, message: 'Access denied.' });
            }

            // Equipment
            const { data: equipment } = await supabase.from('equipments').select('id, serial_number, terminal_type, status, current_location, received_date').eq('merchant_id', merchant_uuid);

            // Notes
            const { data: notes } = await supabase.from('merchant_notes').select('id, title, body, created_at, created_by').eq('merchant_id', merchant_uuid).order('created_at', { ascending: false });

            // RMAs
            const { data: rmas } = await supabase.from('returns').select('id, return_id, return_reason, condition, status, destination, created_at, equipments:equipment_id(serial_number, terminal_type)').eq('merchant_id', merchant_uuid).order('created_at', { ascending: false });

            return res.status(200).json({ success: true, data: { merchant, equipment: equipment || [], notes: notes || [], rmas: rmas || [] } });
        }

        // ── ADD NOTE ───────────────────────────────────────
        if (action === 'add_note') {
            const { merchant_uuid, title, body } = req.body;

            // Verify ownership
            const { data: merchant } = await supabase.from('merchants').select('agent_id').eq('id', merchant_uuid).single();
            if (!merchant || !idStrings.includes(merchant.agent_id)) return res.status(403).json({ success: false });

            const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).single();

            const { error } = await supabase.from('merchant_notes').insert({
                merchant_id: merchant_uuid,
                title: title || 'Partner Note',
                body,
                created_by: person?.full_name || 'Partner'
            });

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // ── REQUEST RMA ────────────────────────────────────
        if (action === 'request_rma') {
            const { merchant_id, equipment_serial, reason, notes } = req.body;
            if (!merchant_id || !reason) return res.status(400).json({ success: false, message: 'Merchant ID and reason required.' });

            // Verify this merchant belongs to this partner
            const { data: merchant } = await supabase.from('merchants').select('agent_id, dba_name').eq('merchant_id', merchant_id).single();
            if (!merchant || !idStrings.includes(merchant.agent_id)) return res.status(403).json({ success: false });

            const { error } = await supabase.from('partner_rma_requests').insert({
                person_id: personId,
                merchant_id,
                equipment_serial,
                reason,
                notes,
                status: 'Pending'
            });

            if (error) throw error;

            // Notify internal staff via messages table
            const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).single();
            await supabase.from('messages').insert({
                sender_id: personId,
                recipient_id: null, // broadcast to admins
                subject: `RMA Request from ${person?.full_name}`,
                body: `Partner ${person?.full_name} has submitted an RMA request for merchant ${merchant_id} (${merchant.dba_name}).\n\nEquipment: ${equipment_serial || 'Not specified'}\nReason: ${reason}\nNotes: ${notes || 'None'}`
            });

            return res.status(200).json({ success: true });
        }

        // ── GET MESSAGES ───────────────────────────────────
        if (action === 'get_messages') {
            const { data: sent } = await supabase.from('messages').select('*').eq('sender_id', personId).order('created_at', { ascending: false });
            const { data: received } = await supabase.from('messages').select('*').eq('recipient_id', personId).order('created_at', { ascending: false });

            // Merge and sort
            const all = [...(sent || []), ...(received || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            return res.status(200).json({ success: true, data: all });
        }

        // ── SEND MESSAGE ───────────────────────────────────
        if (action === 'send_message') {
            const { subject, body } = req.body;
            if (!body) return res.status(400).json({ success: false, message: 'Message body required.' });

            const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).single();

            // Find admin to send to (first super_admin)
            const { data: admin } = await supabase.from('app_users').select('userid').eq('role', 'super_admin').eq('is_active', true).single();

            const { error } = await supabase.from('messages').insert({
                sender_id: personId,
                recipient_id: admin?.userid || null,
                subject: subject || `Message from ${person?.full_name}`,
                body
            });

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // ── EXPORT CSV ─────────────────────────────────────
        if (action === 'export_csv') {
            if (!idStrings.length) return res.status(200).json({ success: true, data: [] });

            const { data } = await supabase.from('merchants')
                .select('merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_30_day, volume_90_day, volume_mtd, email, merchant_phone')
                .in('agent_id', idStrings)
                .order('dba_name');

            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });

    } catch (err) {
        console.error('Partner Data Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
