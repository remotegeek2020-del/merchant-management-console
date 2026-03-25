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
            const { query, page = 1, limit = 10 } = body; // Default to 10 rows per page
            const from = (page - 1) * limit;
            const to = from + limit - 1;

            let request = supabase
                .from('deployments')
                .select(`
                    *,
                    merchants:merchant_id(dba_name, merchant_id),
                    equipments:equipment_id(id, serial_number, terminal_type)
                `, { count: 'exact' }); // Get total count for pagination

            if (query) {
                const searchTerm = `%${query}%`;
                // FIX: Added the alias 'equipments' explicitly inside the OR string
                request = request.or(`deployment_id.ilike.${searchTerm},equipments.serial_number.ilike.${searchTerm}`);
            }

            const { data, error, count } = await request
                .order('created_at', { ascending: false })
                .range(from, to);

            if (error) throw error;

            const safeData = data || [];
            
            // Calculate metrics
            const metrics = {
                active: safeData.filter(d => d.status === 'Open' || d.status === 'In Transit').length,
                total: count || 0, // Use the database count
                today: safeData.filter(d => d.created_at && new Date(d.created_at).toDateString() === new Date().toDateString()).length
            };
            
            return res.status(200).json({ 
                success: true, 
                data: safeData, 
                metrics,
                pagination: {
                    totalRecords: count,
                    currentPage: page,
                    totalPages: Math.ceil(count / limit)
                }
            });
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
      // --- ACTION: RETURN TO OFFICE ---
if (action === 'return_to_office') {
    const { equipment_id, merchant_id, deployment_id, notes, return_type } = payload;

    // 1. Fetch Merchant Name for accurate logging
    const { data: merchantData } = await supabase
        .from('merchants')
        .select('dba_name')
        .eq('id', merchant_id)
        .single();

    const dbaName = merchantData?.dba_name || 'Merchant Field';

    // 2. Create the RMA ticket
    await supabase.from('returns').insert([{
        merchant_id, 
        equipment_id, 
        status: 'open', 
        condition: return_type,
        return_reason: notes || 'Returned from field',
        destination: return_type === 'Defective' ? 'Warsaw Repairs' : 'Warsaw Office'
    }]);

    // 3. Update Equipment status
    await supabase.from('equipments').update({ 
        status: 'pending_return', 
        current_location: 'In Transit / RMA', 
        merchant_id: null 
    }).eq('id', equipment_id);

    // 4. Close Deployment Ticket
    await supabase.from('deployments').update({ status: 'Closed' }).eq('id', deployment_id);

    // 5. Create History Log using the ACTUAL Merchant Name
    await supabase.from('equipment_logs').insert([{
        equipment_id: equipment_id,
        merchant_id: merchant_id, 
        action: 'Initiated Return',
        from_location: dbaName, // Now shows "Better Than Yesterday" instead of "Merchant Field"
        to_location: 'In Transit / RMA',
        notes: `RMA Started. Condition: ${return_type}. Notes: ${notes}`
    }]);

    return res.status(200).json({ success: true });
}

        // --- ACTION: UPDATE ---
      if (action === 'update') {
            const { deployment_id, status, tracking_id, target_date, notes } = payload;

            // 1. Update the deployment ticket
            const { error } = await supabase
                .from('deployments')
                .update({ 
                    status, 
                    tracking_id, 
                    target_deployment_date: target_date, 
                    notes 
                })
                .eq('id', deployment_id);

            if (error) throw error;

            // 2. If status is set to Closed, ensure the equipment is officially 'deployed'
            if (status === 'Closed') {
                // Fetch the equipment_id for this deployment first
                const { data: dep } = await supabase
                    .from('deployments')
                    .select('equipment_id, merchant_id')
                    .eq('id', deployment_id)
                    .single();

                if (dep?.equipment_id) {
                    await supabase.from('equipments').update({ 
                        status: 'deployed' 
                    }).eq('id', dep.equipment_id);
                }
            }

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
