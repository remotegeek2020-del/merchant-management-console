import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, payload, query } = body;

    try {

        if (action === 'log_return') {
    const { 
        equipment_id, 
        merchant_id, 
        deployment_id, 
        reason, 
        notes, 
        return_date_initiated 
    } = payload;

    // 1. Create the Return Record
    const { data: returnData, error: returnError } = await supabase
        .from('returns')
        .insert([{
            equipment_id,
            merchant_id,
            deployment_id,
            return_reason: reason,
            notes,
            return_date_initiated, // Your new field
            status: 'open'
        }]);

    if (returnError) throw returnError;

    // 2. Log the event in equipment_logs
    await supabase.from('equipment_logs').insert([{
        equipment_id,
        merchant_id,
        action: 'return_initiated',
        from_location: 'Merchant Site',
        to_location: 'In Transit',
        notes: `Return initiated: ${reason}`
    }]);

    return res.status(200).json({ success: true });
}

        if (action === 'complete_rma') {
    const { 
        return_id, 
        equipment_id, 
        destination, 
        equipment_received_date 
    } = payload;

    // 1. Update the Returns table
    const { error: updateReturnError } = await supabase
        .from('returns')
        .update({ 
            status: 'completed', 
            destination,
            equipment_received_date // Your new field
        })
        .eq('id', return_id);

    if (updateReturnError) throw updateReturnError;

    // 2. Update Equipment status and location
    const { error: equipError } = await supabase
        .from('equipments')
        .update({ 
            status: 'stocked', 
            current_location: destination,
            merchant_id: null // Remove from merchant
        })
        .eq('id', equipment_id);

    if (equipError) throw equipError;

    // 3. Log the final restock event
    await supabase.from('equipment_logs').insert([{
        equipment_id,
        action: 'rma_completed',
        from_location: 'In Transit',
        to_location: destination,
        notes: `RMA Closed. Received on ${equipment_received_date}`
    }]);

    return res.status(200).json({ success: true });
}
// Inside api/deployments.js
if (action === 'getMonthlyReport') {
    const { startDate, endDate, offset = 0, limit = 1000 } = body;

    const { data, error, count } = await supabase
        .from('deployments')
        .select(`
            deployment_id,
            tid,
            tracking_id,
            target_deployment_date,
            status,
            purchase_type,
            merchants:merchant_id (dba_name, merchant_id),
            equipments:equipment_id (serial_number, terminal_type)
        `, { count: 'exact' })
        .gte('target_deployment_date', startDate)
        .lte('target_deployment_date', endDate)
        .range(offset, offset + limit - 1)
        .order('target_deployment_date', { ascending: false });

    if (error) {
        console.error("Report Error:", error.message);
        return res.status(500).json({ success: false, message: error.message });
    }

    const rawData = data.map(d => ({
        "Deployment ID": d.deployment_id,
        "Date": d.target_deployment_date,
        "Merchant ID": d.merchants?.merchant_id || 'N/A',
        "Merchant Name": d.merchants?.dba_name || 'N/A',
        "Serial": d.equipments?.serial_number || 'N/A',
        "Model": d.equipments?.terminal_type || 'N/A',
        "TID": d.tid || 'N/A',
        "Purchase Type": d.purchase_type || '---',
        "Status": d.status
    }));

    return res.status(200).json({ success: true, rawData, totalCount: count });
}
        // --- ACTION: UPDATE (Restored for Standard Ticket Updates) ---
if (action === 'update') {
    const { deployment_id, status, tracking_id, target_date, notes } = payload;

    // 1. Fetch current data to ensure it exists and to get the equipment_id for logs
    const { data: oldDep, error: fetchError } = await supabase
        .from('deployments')
        .select('status, tracking_id, equipment_id, merchant_id')
        .eq('id', deployment_id)
        .single();

    // Safety Check: if the ticket doesn't exist, stop here
    if (fetchError || !oldDep) {
        return res.status(404).json({ success: false, message: "Deployment ticket not found." });
    }

    // 2. Perform the Update
    const { error: updateError } = await supabase
        .from('deployments')
        .update({ 
            status: status, 
            tracking_id: tracking_id, 
            target_deployment_date: target_date, 
            notes: notes 
        })
        .eq('id', deployment_id);

    if (updateError) throw updateError;

    // 3. Log the change ONLY if status or tracking actually changed
    if (oldDep.status !== status || oldDep.tracking_id !== tracking_id) {
        await supabase.from('equipment_logs').insert([{
            equipment_id: oldDep.equipment_id,
            merchant_id: oldDep.merchant_id,
            deployment_id: deployment_id,
            action: 'TICKET_UPDATED',
            from_location: 'Merchant Site',
            to_location: 'Merchant Site',
            notes: `Status changed to ${status}. Tracking: ${tracking_id || 'None'}`
        }]);
    }

    return res.status(200).json({ success: true });
}

      // --- ACTION: check_rma ---
if (action === 'check_rma') {
    const { deployment_id } = body.payload;
    // We explicitly fetch 'return_id' which is your custom identifier
    const { data, error } = await supabase
        .from('returns')
        .select('return_id, id, status, return_reason') 
        .eq('deployment_id', deployment_id)
        .maybeSingle();
    
    return res.status(200).json({ success: true, data: data || null });
}
       // --- ACTION: DELETE (Fixed for Foreign Key Constraints) ---
if (action === 'delete') {
    const { deployment_id, equipment_id, merchant_id, merchant_name, serial_number } = payload || {};

    if (!deployment_id) {
        return res.status(400).json({ success: false, message: "Missing Deployment ID" });
    }

    try {
        // 1. DELETE LINKED RMA FIRST (Fixes the Foreign Key Error)
        // This removes the "child" record so we can delete the "parent" deployment
        const { error: rmaDeleteError } = await supabase
            .from('returns')
            .delete()
            .eq('deployment_id', deployment_id);

        if (rmaDeleteError) throw rmaDeleteError;

        // 2. Reset Equipment status
        if (equipment_id) {
            await supabase.from('equipments').update({ 
                status: 'stocked', 
                current_location: 'Warsaw Office',
                merchant_id: null 
            }).eq('id', equipment_id);

            // Log the reset
            await supabase.from('equipment_logs').insert([{
                equipment_id: equipment_id,
                merchant_id: merchant_id,
                action: 'TICKET_DELETED',
                from_location: merchant_name || 'Merchant Site',
                to_location: 'Warsaw Office',
                notes: `Ticket ${deployment_id} and its RMA were deleted. Unit reset to stock.`
            }]);
        }

        // 3. NOW DELETE THE DEPLOYMENT (The "Parent" record)
        const { error: deleteError } = await supabase
            .from('deployments')
            .delete()
            .eq('id', deployment_id);

        if (deleteError) throw deleteError;

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error("Delete Operation Failed:", err.message);
        return res.status(500).json({ success: false, message: "Database error: " + err.message });
    }
}
        
        // --- ACTION: LIST (With Fix for Search & KPI Metrics) ---
        if (action === 'list') {
            const { query, page = 1, limit = 10 } = body;
            const from = (page - 1) * limit;
            const to = from + limit - 1;

            let request = supabase
                .from('deployments')
                .select(`
                    *,
                    merchants:merchant_id(dba_name, merchant_id),
                    equipments:equipment_id(id, serial_number, terminal_type)
                `, { count: 'exact' });

            if (query) {
                const term = `%${query}%`;
                const { data: matchedEquip } = await supabase
                    .from('equipments')
                    .select('id')
                    .ilike('serial_number', term);

                const equipIds = (matchedEquip || []).map(e => e.id);

                if (equipIds.length > 0) {
                    request = request.or(`deployment_id.ilike.${term},equipment_id.in.(${equipIds.join(',')})`);
                } else {
                    request = request.ilike('deployment_id', term);
                }
            }

            const { data, error, count } = await request
                .order('created_at', { ascending: false })
                .range(from, to);

            if (error) throw error;

            // SURGICAL FIX: Fetch real counts from the database for KPIs
            // 1. Get Active Count (Open or In Transit)
            const { count: activeCount } = await supabase
                .from('deployments')
                .select('*', { count: 'exact', head: true })
                .in('status', ['Open', 'In Transit']);

            // 2. Get Today's Count
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);
            const { count: todayCount } = await supabase
                .from('deployments')
                .select('*', { count: 'exact', head: true })
                .gte('created_at', startOfDay.toISOString());

            const safeData = data || [];
            const metrics = {
                active: activeCount || 0,
                total: count || 0,
                today: todayCount || 0
            };
            
            return res.status(200).json({ 
                success: true, 
                data: safeData, 
                metrics,
                pagination: {
                    totalRecords: count,
                    currentPage: page,
                    totalPages: Math.ceil((count || 0) / limit)
                }
            });
        }

        // --- ACTION: CREATE ---
       if (action === 'create') {
    const { merchant_id, equipment_id, tid, tracking_id, target_date, notes } = payload;

    // 1. SURGICAL ATOMIC CHECK: Verify equipment is still 'stocked' right now
    const { data: checkEquip, error: checkError } = await supabase
        .from('equipments')
        .select('status, serial_number')
        .eq('id', equipment_id)
        .single();

    if (checkError || !checkEquip) throw new Error("Equipment not found.");
    
    // If someone else grabbed it 1 second ago, the status won't be 'stocked'
    if (checkEquip.status !== 'stocked') {
        return res.status(400).json({ 
            success: false, 
            message: `Conflict: Serial ${checkEquip.serial_number} was just deployed by another user.` 
        });
    }

    // 2. Proceed with creation only if the check passed
    const { data: merchantData } = await supabase.from('merchants').select('dba_name').eq('id', merchant_id).single();
    const dbaName = merchantData?.dba_name || 'Client Site';

    const { data: newDep, error: depError } = await supabase
        .from('deployments')
        .insert([{ merchant_id, equipment_id, tid, tracking_id, target_deployment_date: target_date, notes, status: 'Open' }])
        .select();

    if (depError) throw depError;

    // 3. Update equipment to 'deployed' so it disappears from other users' lookups
    await supabase.from('equipments')
        .update({ status: 'deployed', current_location: dbaName, merchant_id })
        .eq('id', equipment_id);

    await supabase.from('equipment_logs').insert([{
        equipment_id, merchant_id, action: 'Deployed', from_location: 'Warsaw Office', to_location: dbaName, notes: `Deployment Created. TID: ${tid}`
    }]);

    return res.status(200).json({ success: true, data: newDep });
}
      // --- ACTION: RETURN TO OFFICE (Enhanced for 4 States) ---
// --- ACTION: RETURN TO OFFICE (Robust Version) ---
if (action === 'return_to_office') {
    const { 
        equipment_id, 
        merchant_id,
        deployment_id, 
        return_type, 
        notes, 
        return_date_initiated, 
        equipment_received_date 
    } = req.body.payload; 

    try {
        if (return_type === 'In Transit') {
            // STEP 1: INITIATE RMA
            const { error } = await supabase
                .from('returns')
                .upsert({
                    deployment_id: deployment_id,
                    equipment_id: equipment_id,
                    merchant_id: merchant_id,
                    return_reason: notes,
                    return_date_initiated: return_date_initiated,
                    // NEW: Set exact status/destination for transit
                    condition: 'IN TRANSIT',
                    destination: 'In Transit / RMA',
                    status: 'Open'
                }, { onConflict: 'deployment_id' });

            if (error) throw error;
        } else {
            // STEP 2: COMPLETE RMA
            // Determine condition and destination based on the button clicked in the frontend
            let finalCondition = '';
            let finalDestination = '';

            if (return_type === 'Working (Back to Stock)') {
                finalCondition = 'Working (Back to Stock)';
                finalDestination = 'Warsaw Office';
            } else {
                finalCondition = 'Defective (Received in Repairs)';
                finalDestination = 'Warsaw Repairs';
            }

            const { error: returnUpdateError } = await supabase
                .from('returns')
                .update({
                    status: 'Closed',
                    condition: finalCondition, // Updated
                    destination: finalDestination,
                    equipment_received_date: equipment_received_date 
                })
                .eq('deployment_id', deployment_id);

            if (returnUpdateError) throw returnUpdateError;

            // Move equipment back to warehouse in the equipments table
            await supabase.from('equipments').update({
                status: 'stocked',
                current_location: finalDestination,
                merchant_id: null
            }).eq('id', equipment_id);
        }

        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
        // --- ACTION: LOOKUPS (Updated for MID + DBA search) ---
if (action === 'getLookups') {
    const term = `%${query || ''}%`;
    
    // Search BOTH dba_name and merchant_id using the new index
    const { data: merchants } = await supabase
        .from('merchants')
        .select('id, dba_name, merchant_id')
        .or(`dba_name.ilike.${term},merchant_id.ilike.${term}`) 
        .limit(10); 

    const { data: inventory } = await supabase
        .from('equipments')
        .select('id, serial_number, terminal_type, status')
        .eq('status', 'stocked')
        .ilike('serial_number', term)
        .limit(10);

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
