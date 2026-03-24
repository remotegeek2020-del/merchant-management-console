import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // 1. Force the response to always be JSON
    res.setHeader('Content-Type', 'application/json');

    try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return res.status(500).json({ success: false, message: "Env variables missing" });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);
        
        // Handle empty body safely
        const body = req.body || {};
        const { action, id, payload, query } = body;

        // --- ACTION: LIST ---
        if (action === 'list') {
            const { data, error } = await supabase
                .from('returns')
                .select(`
                    id, return_id, return_reason, condition, destination, status, created_at,
                    merchant_id, equipment_id,
                    merchants:merchant_id (dba_name, merchant_id),
                    equipments:equipment_id (serial_number, terminal_type)
                `)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const metrics = {
                open: data ? data.filter(d => d.status === 'open').length : 0,
                defective: data ? data.filter(d => d.condition === 'Defective').length : 0
            };

            return res.status(200).json({ success: true, data: data || [], metrics, count: data?.length || 0 });
        }

        // --- ACTION: COMPLETE RETURN ---
        if (action === 'complete_return') {
            const { id: rmaId, equipment_id, condition, destination } = payload || {};

            if (!rmaId || !equipment_id) throw new Error("Missing IDs in payload");

            // Update Return Table
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

        return res.status(400).json({ success: false, message: "Invalid action: " + action });

    } catch (err) {
        // This is the CRITICAL part: It sends the error as JSON so the dashboard can read it
        console.error("Internal Server Error:", err.message);
        return res.status(500).json({ 
            success: false, 
            message: "Server Error: " + err.message 
        });
    }
}
