import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, payload, query } = body;

    try {

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
        // --- ACTION: DELETE (Reset Equipment + Log Activity) ---
    // --- ACTION: DELETE (Surgical Fix) ---
if (action === 'delete') {
    // Destructure from payload directly to ensure we have the IDs
    const { deployment_id, equipment_id, merchant_id, merchant_name, serial_number } = payload || {};

    if (!deployment_id) {
        return res.status(400).json({ success: false, message: "Missing Deployment ID" });
    }

    try {
        // 1. Reset Equipment status if an ID was provided
        if (equipment_id) {
            await supabase.from('equipments').update({ 
                status: 'stocked', 
                current_location: 'Warsaw Office',
                merchant_id: null 
            }).eq('id', equipment_id);

            // Log the return to stock
            await supabase.from('equipment_logs').insert([{
                equipment_id: equipment_id,
                merchant_id: merchant_id,
                action: 'TICKET_DELETED',
                from_location: merchant_name || 'Merchant Site',
                to_location: 'Warsaw Office',
                notes: `Deployment ticket ${deployment_id} deleted manually. Unit reset to stock.`
            }]);
        }

        // 2. CRITICAL: Delete the deployment ticket
        const { error: deleteError } = await supabase
            .from('deployments')
            .delete()
            .eq('id', deployment_id);

        if (deleteError) throw deleteError;

        // 3. Log administrative activity
        await supabase.from('activity_logs').insert([{
            email: 'admin@secureconsole.com',
            action: 'DELETE_DEPLOYMENT',
            status: 'Success',
            details: `Deleted ticket ${deployment_id} for ${merchant_name || 'Unknown'}.`
        }]);

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
    try {
        const { equipment_id, merchant_id, deployment_id, notes, return_type } = payload;

        // 1. Fetch Existing RMA to preserve the ID and the ORIGINAL Reason
        const { data: existingRma } = await supabase
            .from('returns')
            .select('return_reason, id, status')
            .eq('deployment_id', deployment_id)
            .maybeSingle();

        // 2. LOGIC: If we are "Completing", we keep the old reason. 
        // If it's brand new, we use the 'notes' from the dropdown.
        const persistentReason = (existingRma && existingRma.return_reason) ? existingRma.return_reason : notes;

        // 3. Determine if this is a "Completion" (Received) or "Initiation" (In Transit)
        let isCompleting = (return_type.includes('Stock') || return_type.includes('Repairs'));
        let rmaStatus = isCompleting ? 'Closed' : 'open';
        let equipStatus = isCompleting ? (return_type.includes('Repairs') ? 'repairing' : 'stocked') : 'pending_return';
        let finalLoc = isCompleting ? (return_type.includes('Repairs') ? 'Warsaw Repairs' : 'Warsaw Office') : 'In Transit / RMA';

        // 4. UPSERT RMA: Maintain the link and the reason
        const { error: rmaError } = await supabase.from('returns').upsert({
            deployment_id: deployment_id,
            equipment_id: equipment_id,
            merchant_id: merchant_id,
            status: rmaStatus,
            condition: return_type, // Updated to 'Working' or 'Defective'
            destination: finalLoc,
            return_reason: persistentReason // REQUIREMENT 2: Reason never changes
        }, { onConflict: 'deployment_id' });

        if (rmaError) throw rmaError;

        // 5. Update Equipment & Location (Requirement 1: It actually completes now)
        await supabase.from('equipments').update({ 
            status: equipStatus, 
            current_location: finalLoc,
            merchant_id: isCompleting ? null : merchant_id 
        }).eq('id', equipment_id);

        // 6. Lifecycle Log
        await supabase.from('equipment_logs').insert([{
            equipment_id,
            merchant_id,
            deployment_id,
            action: isCompleting ? 'RMA_COMPLETED' : 'RMA_INITIATED',
            from_location: isCompleting ? 'In Transit' : 'Merchant Site',
            to_location: finalLoc,
            notes: `Final Condition: ${return_type} | Original Reason: ${persistentReason}`
        }]);

        // 7. Ensure Deployment is Closed
        await supabase.from('deployments').update({ status: 'Closed' }).eq('id', deployment_id);

        return res.status(200).json({ success: true });

    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
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
