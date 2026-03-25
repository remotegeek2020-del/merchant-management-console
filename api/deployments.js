import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, payload, query } = body;

    try {
        // --- ACTION: DELETE (Reset Equipment + Log Activity) ---
        if (action === 'delete') {
            const { deployment_id, equipment_id, merchant_id, merchant_name, serial_number, user_email } = payload || {};

            // 1. Reset Equipment Status to Stock
            if (equipment_id) {
                await supabase.from('equipments').update({ 
                    status: 'stocked', 
                    current_location: 'Warsaw Office',
                    merchant_id: null 
                }).eq('id', equipment_id);

                // 2. Add log to Equipment Lifecycle (So it shows in Merchant Dashboard)
                await supabase.from('equipment_logs').insert([{
                    equipment_id: equipment_id,
                    merchant_id: merchant_id,
                    action: 'Ticket Deleted',
                    from_location: merchant_name || 'Merchant Site',
                    to_location: 'Warsaw Office',
                    notes: `Deployment ticket ${deployment_id} deleted. Unit returned to stock.`
                }]);
            }

            // 3. Delete the Deployment record
            await supabase.from('deployments').delete().eq('id', deployment_id);

            // 4. Log to activity_logs (Your Audit Table)
            await supabase.from('activity_logs').insert([{
                email: user_email || 'admin@secureconsole.com',
                action: 'DELETE_DEPLOYMENT',
                status: 'Success',
                details: `Deleted ticket ${deployment_id} for ${merchant_name}. HW ${serial_number} reset to Stock.`
            }]);

            return res.status(200).json({ success: true });
        }
        
        // --- ACTION: LIST (With Crash-Proof Metrics) ---
       if (action === 'list') {
            const { data, error } = await supabase
                .from('deployments')
                .select(`
                    *,
                    merchants:merchant_id(dba_name, merchant_id),
                    equipments:equipment_id(id, serial_number, terminal_type)
                `)
                .order('created_at', { ascending: false });

            if (error) {
                console.error("Database Error:", error);
                return res.status(500).json({ success: false, message: error.message });
            }

            const safeData = data || [];
            const metrics = {
                active: safeData.filter(d => d.status === 'Open' || d.status === 'In Transit').length,
                total: safeData.length,
                today: safeData.filter(d => d.created_at && new Date(d.created_at).toDateString() === new Date().toDateString()).length
            };
            return res.status(200).json({ success: true, data: safeData, metrics });
        }
        // --- ACTION: CREATE ---
        if (action === 'create') {
            const { merchant_id, equipment_id, tid, tracking_id, target_date, notes } = payload;
            const { data: merchantData } = await supabase.from('merchants').select('dba_name').eq('id', merchant_id).single();
            const dbaName = merchantData?.dba_name || 'Client Site';

            const { data: newDep, error: depError } = await supabase
                .from('deployments')
                .insert([{ merchant_id, equipment_id, tid, tracking_id, target_deployment_date: target_date, notes, status: 'Open' }]).select();

            if (depError) throw depError;

            await supabase.from('equipments').update({ status: 'deployed', current_location: dbaName, merchant_id }).eq('id', equipment_id);

            await supabase.from('equipment_logs').insert([{
                equipment_id, merchant_id, action: 'Deployed', from_location: 'Warsaw Office', to_location: dbaName, notes: `Deployment Created. TID: ${tid}`
            }]);

            return res.status(200).json({ success: true, data: newDep });
        }

        // --- ACTION: RETURN TO OFFICE ---
        if (action === 'return_to_office') {
            const { equipment_id, merchant_id, deployment_id, notes, return_type } = payload;
            await supabase.from('returns').insert([{
                merchant_id, equipment_id, status: 'open', condition: return_type,
                return_reason: notes || 'Returned from field',
                destination: return_type === 'Defective' ? 'Warsaw Repairs' : 'Warsaw Office'
            }]);

            await supabase.from('equipments').update({ status: 'pending_return', current_location: 'In Transit / RMA', merchant_id: null }).eq('id', equipment_id);
            await supabase.from('deployments').update({ status: 'Closed' }).eq('id', deployment_id);
            await supabase.from('equipment_logs').insert([{
                equipment_id, merchant_id, action: 'Initiated Return', from_location: 'Merchant Field', to_location: 'In Transit / RMA',
                notes: `RMA Started. Condition: ${return_type}. Notes: ${notes}`
            }]);

            return res.status(200).json({ success: true });
        }

        // --- ACTION: UPDATE ---
        if (action === 'update') {
            const { deployment_id, status, tracking_id, target_date, notes } = payload;
            const { error } = await supabase.from('deployments').update({ status, tracking_id, target_deployment_date: target_date, notes }).eq('id', deployment_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ACTION: LOOKUPS ---
        if (action === 'getLookups') {
            const { data: merchants } = await supabase.from('merchants').select('id, dba_name, merchant_id').ilike('dba_name', `%${query || ''}%`).limit(5);
            const { data: inventory } = await supabase.from('equipments').select('id, serial_number, terminal_type, status').eq('status', 'stocked').ilike('serial_number', `%${query || ''}%`).limit(10);
            return res.status(200).json({ merchants, inventory });
        }

        // --- ACTION: HISTORY ---
        if (action === 'getHistory') {
            const { data, error } = await supabase.from('equipment_logs').select('*').eq('equipment_id', body.equipment_id).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) { 
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message }); 
    }
}
