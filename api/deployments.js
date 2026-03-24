import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, payload, query } = body;

    try {
        if (action === 'list') {
            const { data, error } = await supabase
                .from('deployments')
                .select('*, merchants!merchant_id(dba_name, merchant_id), equipments!equipment_id(id, serial_number, terminal_type)')
                .order('created_at', { ascending: false });

            if (error) throw error;
            const metrics = {
                active: data ? data.filter(d => d.status === 'Open' || d.status === 'In Transit').length : 0,
                total: data ? data.length : 0,
                today: data ? data.filter(d => new Date(d.created_at).toDateString() === new Date().toDateString()).length : 0
            };
            return res.status(200).json({ success: true, data: data || [], metrics });
        }

        if (action === 'create') {
            const { merchant_id, equipment_id, tid, tracking_id, target_date, notes } = payload;
            const { data: newDep, error: depError } = await supabase
                .from('deployments')
                .insert([{ merchant_id, equipment_id, tid, tracking_id, target_deployment_date: target_date, notes, status: 'Open' }]).select();

            if (depError) throw depError;

            await supabase.from('equipments').update({ 
                status: 'deployed', current_location: 'Client Site', merchant_id: merchant_id 
            }).eq('id', equipment_id);

            await supabase.from('equipment_logs').insert([{
                equipment_id,
                merchant_id, // Link for merchant dashboard
                action: 'Deployed',
                from_location: 'Warsaw Office',
                to_location: 'Client Site',
                notes: `Deployment Created. TID: ${tid}`
            }]);

            return res.status(200).json({ success: true, data: newDep });
        }

        if (action === 'return_to_office') {
            const { equipment_id, merchant_id, deployment_id, notes, return_type } = payload;
            
            // 1. Create Return Ticket
            await supabase.from('returns').insert([{
                merchant_id, equipment_id, return_reason: notes || 'Field Return',
                condition: return_type, destination: return_type === 'Defective' ? 'Warsaw Repairs' : 'Warsaw Office', status: 'open'
            }]);

            // 2. Update Equipment
            await supabase.from('equipments').update({ status: 'pending_return', current_location: 'In Transit / RMA', merchant_id: null }).eq('id', equipment_id);

            // 3. Close Deployment
            await supabase.from('deployments').update({ status: 'Closed' }).eq('id', deployment_id);

            // 4. Log History with merchant_id link
            await supabase.from('equipment_logs').insert([{
                equipment_id,
                merchant_id, // CRITICAL: Link for merchant dashboard
                action: 'Initiated Return',
                from_location: 'Merchant Field',
                to_location: 'In Transit / RMA',
                notes: `RMA Started. Condition: ${return_type}`
            }]);

            return res.status(200).json({ success: true });
        }

        if (action === 'update') {
            const { deployment_id, status, tracking_id, target_date, notes } = payload;
            const { error } = await supabase.from('deployments').update({ status, tracking_id, target_deployment_date: target_date, notes }).eq('id', deployment_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'getLookups') {
            const { data: merchants } = await supabase.from('merchants').select('id, dba_name, merchant_id').ilike('dba_name', `%${query || ''}%`).limit(5);
            const { data: inventory } = await supabase.from('equipments').select('id, serial_number, terminal_type').eq('status', 'stocked');
            return res.status(200).json({ merchants, inventory });
        }

        if (action === 'getHistory') {
            const { data, error } = await supabase.from('equipment_logs').select('*').eq('equipment_id', body.equipment_id).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });
    } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
}
