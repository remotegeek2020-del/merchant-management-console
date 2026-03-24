import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // 1. Initialize Supabase
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    // 2. Always set header to JSON to prevent the "Unexpected Token A" error
    res.setHeader('Content-Type', 'application/json');

    const { action, payload, query, id } = req.body || {};

    try {
        // --- ACTION: LIST ---
        if (action === 'list') {
            let sb = supabase.from('deployments').select(`
                *,
                merchants!merchant_id (dba_name, merchant_id),
                equipments!equipment_id (id, serial_number, terminal_type)
            `);
            
            if (query) {
                sb = sb.or(`deployment_id.ilike.%${query}%,tid.ilike.%${query}%,tracking_id.ilike.%${query}%`);
            }

            const { data, error } = await sb.order('created_at', { ascending: false });
            if (error) throw error;

            const metrics = {
                active: data ? data.filter(d => d.status === 'Open' || d.status === 'In Transit').length : 0,
                total: data ? data.length : 0,
                today: data ? data.filter(d => new Date(d.created_at).toDateString() === new Date().toDateString()).length : 0
            };

            return res.status(200).json({ success: true, data: data || [], metrics });
        }

        // --- ACTION: RETURN TO OFFICE ---
        if (action === 'return_to_office') {
            const { equipment_id, merchant_id, deployment_id, notes, return_type } = payload;
            const newLocation = 'In Transit / RMA';

            // A. Create the RMA ticket in 'returns' table
            const { error: returnError } = await supabase.from('returns').insert([{
                merchant_id,
                equipment_id,
                return_reason: notes || 'Unit returned from field',
                condition: return_type, 
                destination: return_type === 'Defective' ? 'Warsaw Repairs' : 'Warsaw Office',
                status: 'open'
            }]);
            if (returnError) throw returnError;

            // B. Update Equipment to 'pending_return' status
            const { error: equipError } = await supabase.from('equipments').update({ 
                status: 'pending_return', 
                current_location: newLocation,
                merchant_id: null 
            }).eq('id', equipment_id);
            if (equipError) throw equipError;

            // C. Close the Deployment Ticket
            const { error: depError } = await supabase.from('deployments').update({ 
                status: 'Closed' 
            }).eq('id', deployment_id);
            if (depError) throw depError;

            // D. Create the History Log entry
            const { error: logError } = await supabase.from('equipment_logs').insert([{
                equipment_id: equipment_id,
                action: 'Initiated Return',
                from_location: 'Merchant Field',
                to_location: newLocation,
                notes: `RMA Started: ${notes || 'No notes'}`
            }]);
            if (logError) throw logError;

            return res.status(200).json({ success: true });
        }

        // --- ACTION: UPDATE (Standard Ticket Update) ---
        if (action === 'update') {
            const { deployment_id, status, tracking_id, target_date, notes } = payload;
            const { error } = await supabase.from('deployments').update({ 
                status, 
                tracking_id, 
                target_deployment_date: target_date, 
                notes 
            }).eq('id', deployment_id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ACTION: LOOKUPS ---
        if (action === 'getLookups') {
            const { data: merchants } = await supabase.from('merchants').select('id, dba_name, merchant_id').ilike('dba_name', `%${query}%`).limit(5);
            const { data: inventory } = await supabase.from('equipments').select('id, serial_number, terminal_type').eq('status', 'stocked');
            return res.status(200).json({ merchants, inventory });
        }

        // --- ACTION: GET HISTORY ---
        if (action === 'getHistory') {
            const { equipment_id } = req.body; 
            const { data, error } = await supabase.from('equipment_logs')
                .select('*')
                .eq('equipment_id', equipment_id)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error("Deployments API Error:", err.message);
        return res.status(500).json({ success: false, message: "Server Error: " + err.message });
    }
}
