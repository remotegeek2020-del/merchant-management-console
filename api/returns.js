import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    // 1. Initialize Supabase with a check
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ success: false, message: "Missing Environment Variables on Vercel" });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const { action, id, payload, query } = req.body || {};

    try {
        // --- ACTION: LIST ---
        if (action === 'list') {
            let sb = supabase.from('returns').select(`
                id, return_id, return_reason, condition, destination, status, created_at,
                merchants:merchant_id (dba_name, merchant_id),
                equipments:equipment_id (serial_number, terminal_type)
            `);

            if (query) {
                sb = sb.or(`return_id.ilike.%${query}%,condition.ilike.%${query}%`);
            }

            const { data, error } = await sb.order('created_at', { ascending: false });
            if (error) throw error;

            const metrics = {
                open: data ? data.filter(d => d.status === 'open').length : 0,
                defective: data ? data.filter(d => d.condition === 'Defective').length : 0
            };

            return res.status(200).json({ success: true, data: data || [], metrics, count: data ? data.length : 0 });
        }

        // --- ACTION: COMPLETE RETURN ---
        if (action === 'complete_return') {
            const { id: rmaId, equipment_id, condition, destination } = payload;

            // Update Return Ticket
            const { error: rmaError } = await supabase
                .from('returns')
                .update({ status: 'closed' })
                .eq('id', rmaId);
            if (rmaError) throw rmaError;

            // Update Equipment Table
            const finalStatus = (condition === 'Defective') ? 'repairing' : 'stocked';
            const { error: equipError } = await supabase
                .from('equipments')
                .update({ 
                    status: finalStatus,
                    current_location: destination 
                })
                .eq('id', equipment_id);
            if (equipError) throw equipError;

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error("Returns API Error:", err.message);
        // This ensures the frontend ALWAYS receives JSON, even on a 500 error
        return res.status(500).json({ success: false, message: err.message });
    }
}
