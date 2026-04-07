import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    try {
        if (action === 'getMonthlyReport') {
    const { startDate, endDate } = req.body;

    const { data, error } = await supabase
        .from('equipment_logs')
        .select(`
            *,
            merchants:merchant_id (dba_name),
            equipments:equipment_id (serial_number)
        `)
        .in('action', ['return', 'repair', 'decommission'])
        .gte('created_at', startDate)
        .lte('created_at', endDate + 'T23:59:59');

    if (error) throw error;

    const flattenedData = data.map(row => ({
        Date: new Date(row.created_at).toLocaleDateString(),
        Action: row.action,
        Merchant: row.merchants?.dba_name || 'N/A',
        Serial: row.equipments?.serial_number || 'N/A',
        Note: row.status || ''
    }));

    return res.status(200).json({ success: true, rawData: flattenedData });
}
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !supabaseKey) return res.status(500).json({ success: false, message: "Env variables missing" });

        const supabase = createClient(supabaseUrl, supabaseKey);
        const body = req.body || {};
        const { action, id, payload, query } = body;

        if (action === 'list') {
            const { data, error } = await supabase.from('returns').select(`
                id, return_id, return_reason, condition, destination, status, created_at,
                merchant_id, equipment_id,
                merchants:merchant_id (dba_name, merchant_id),
                equipments:equipment_id (serial_number, terminal_type)
            `).order('created_at', { ascending: false });

            if (error) throw error;
            const metrics = {
                open: data ? data.filter(d => d.status === 'open').length : 0,
                defective: data ? data.filter(d => d.condition === 'Defective').length : 0
            };
            return res.status(200).json({ success: true, data: data || [], metrics, count: data?.length || 0 });
        }

        if (action === 'complete_return') {
            const { id: rmaId, equipment_id, condition, destination, merchant_id } = payload || {};
            if (!rmaId || !equipment_id) throw new Error("Missing IDs in payload");

            await supabase.from('returns').update({ status: 'closed' }).eq('id', rmaId);

            const finalStatus = condition === 'Defective' ? 'repairing' : 'stocked';
            await supabase.from('equipments').update({ status: finalStatus, current_location: destination }).eq('id', equipment_id);

            // Final history log linked to the merchant
            await supabase.from('equipment_logs').insert([{
                equipment_id,
                merchant_id, // Link for merchant dashboard history
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
