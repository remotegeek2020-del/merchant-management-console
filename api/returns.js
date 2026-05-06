
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !supabaseKey) return res.status(500).json({ success: false, message: "Env variables missing" });

        const supabase = createClient(supabaseUrl, supabaseKey);
        const body = req.body || {};
        const { action, id, payload, query } = body;

     // Inside api/returns.js handler
// Inside api/returns.js
if (action === 'getMonthlyReport') {
    const { startDate, endDate, offset = 0, limit = 1000 } = req.body;

    const { data, error, count } = await supabase
        .from('returns')
        .select(`
            return_id,
            return_reason,
            status,
            return_date_initiated,
            merchants:merchant_id (
                dba_name, 
                merchant_id
            ),
            equipments:equipment_id (serial_number)
        `, { count: 'exact' })
        .gte('return_date_initiated', startDate)
        .lte('return_date_initiated', endDate)
        .range(offset, offset + limit - 1);

    if (error) throw error;

    const rawData = data.map(d => ({
        "Return ID": d.return_id,
        "Date Initiated": d.return_date_initiated || '---',
        "Merchant ID": d.merchants?.merchant_id || 'N/A', // Correctly nested
        "Merchant Name": d.merchants?.dba_name || 'N/A',
        "Serial": d.equipments?.serial_number || 'N/A',
        "Reason": d.return_reason,
        "Status": d.status
    }));

    return res.status(200).json({ success: true, rawData, totalCount: count });
}
       if (action === 'list') {
    const searchQuery = query || '';
    let q = supabase.from('returns').select(`
        id, return_id, return_reason, condition, destination, status, created_at,
        return_date_initiated, equipment_received_date,
        merchant_id, equipment_id, ticket_id,
        merchants:merchant_id (dba_name, merchant_id),
        equipments:equipment_id (serial_number, terminal_type)
    `).order('return_date_initiated', { ascending: false });

    if (searchQuery) {
        q = q.or(`return_id.ilike.%${searchQuery}%,condition.ilike.%${searchQuery}%`);
    }

    const { data, error } = await q;

    if (error) throw error;

    const metrics = {
        open: data ? data.filter(d => d.status.toLowerCase() === 'open').length : 0,
        defective: data ? data.filter(d => d.condition && d.condition.includes('Defective')).length : 0
    };

    return res.status(200).json({
        success: true,
        data: data || [],
        metrics,
        count: data?.length || 0
    });
}

    // Inside api/returns.js -> action === 'complete_return'
if (action === 'complete_return') {
    const { id: rmaId, equipment_id, condition, destination, merchant_id } = payload || {};
    if (!rmaId || !equipment_id) throw new Error("Missing IDs in payload");

    // 1. Fetch linked deployment_id, merchant_id, and ticket_id
    const { data: rmaData } = await supabase
        .from('returns')
        .select('deployment_id, merchant_id, ticket_id')
        .eq('id', rmaId)
        .single();

    const resolved_merchant_id = merchant_id || rmaData?.merchant_id || null;

    if (rmaData?.deployment_id) {
        // 2. Close the linked deployment
        await supabase.from('deployments')
            .update({ status: 'Closed' })
            .eq('id', rmaData.deployment_id);
    }

    // 3. Close RMA with capital-C status (consistent with check_rma comparison)
    await supabase.from('returns').update({
        status: 'Closed',
        condition: condition,
        destination: destination
    }).eq('id', rmaId);

    // 4. Update equipment status
    const finalStatus = (condition.toLowerCase().includes('working') || destination === 'Warsaw Office') ? 'stocked' : 'repairing';
    await supabase.from('equipments').update({
        status: finalStatus,
        current_location: destination,
        merchant_id: null
    }).eq('id', equipment_id);

    // 5. Auto-close the linked support ticket
    if (rmaData?.ticket_id) {
        await supabase.from('support_tickets')
            .update({ status: 'closed', updated_at: new Date().toISOString() })
            .eq('id', rmaData.ticket_id);
        await supabase.from('ticket_comments').insert({
            ticket_id: rmaData.ticket_id,
            author_type: 'system',
            author_name: 'System',
            change_summary: `RMA completed. Unit received at ${destination} as ${condition}. Ticket auto-closed.`,
            is_internal: false
        });
    }

    // 6. Log equipment history
    await supabase.from('equipment_logs').insert([{
        equipment_id,
        merchant_id: resolved_merchant_id,
        action: 'RMA Completed',
        from_location: 'In Transit / RMA',
        to_location: destination,
        notes: `Inspection finished. Unit marked as ${condition}.`
    }]);

    return res.status(200).json({ success: true });
}
        if (action === 'getHistory') {
            const targetId = body.equipment_id; 
            const { data, error } = await supabase.from('equipment_logs').select('*').eq('equipment_id', targetId).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: "Invalid action" });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Server Error: " + err.message });
    }
}
