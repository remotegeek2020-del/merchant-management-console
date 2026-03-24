import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    // Safety: Ensure we are getting the body
    const { action, id, payload, query } = req.body || {};

    try {
        // --- ACTION: LIST ---
        if (action === 'list') {
            let sb = supabase.from('returns').select(`
                id,
                return_id,
                return_reason,
                condition,
                destination,
                status,
                created_at,
                merchant_id,
                equipment_id,
                merchants:merchant_id (dba_name, merchant_id),
                equipments:equipment_id (serial_number, terminal_type)
            `);

            if (query) {
                sb = sb.or(`return_id.ilike.%${query}%,condition.ilike.%${query}%`);
            }

            const { data, error } = await sb.order('created_at', { ascending: false });
            if (error) throw error;

            // Calculate Metrics
            const metrics = {
                open: data.filter(d => d.status === 'open').length,
                defective: data.filter(d => d.condition === 'Defective').length
            };

            return res.status(200).json({ success: true, data: data || [], metrics, count: data.length });
        }

        // --- ACTION: COMPLETE RETURN (The 2nd Step) ---
        if (action === 'complete_return') {
            const { id: rmaId, equipment_id, condition, destination } = payload;

            // 1. Close the RMA Ticket
            const { error: rmaError } = await supabase
                .from('returns')
                .update({ status: 'closed' })
                .eq('id', rmaId);

            if (rmaError) throw rmaError;

            // 2. Finalize Equipment Status
            const finalStatus = (condition === 'Defective') ? 'repairing' : 'stocked';
            
            const { error: equipError } = await supabase
                .from('equipments')
                .update({ 
                    status: finalStatus,
                    current_location: destination // e.g. 'Warsaw Office'
                })
                .eq('id', equipment_id);

            if (equipError) throw equipError;

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error("Returns API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
