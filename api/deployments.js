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

    const { data: oldDep } = await supabase
        .from('deployments')
        .select('status, equipment_id, merchant_id')
        .eq('id', deployment_id)
        .single();

    // Fetch the DBA Name
    const { data: mData } = await supabase.from('merchants').select('dba_name').eq('id', oldDep.merchant_id).maybeSingle();
    const dba = mData?.dba_name || 'Merchant Site';

    await supabase.from('deployments').update({ 
        status, tracking_id, target_deployment_date: target_date, notes 
    }).eq('id', deployment_id);

    if (oldDep.status !== status) {
        await supabase.from('equipment_logs').insert([{
            equipment_id: oldDep.equipment_id,
            merchant_id: oldDep.merchant_id,
            deployment_id: deployment_id,
            action: 'TICKET_UPDATED',
            from_location: dba, // Use DBA here
            to_location: dba,   // Use DBA here
            notes: `Status changed to ${status}`
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
    try {
        const { equipment_id, merchant_id, deployment_id, notes, return_type } = payload;

        // 1. FETCH THE ACTUAL BUSINESS NAME (Fixes "Merchant Site" issue)
        let dba = 'Merchant Site'; 
        if (merchant_id) {
            const { data: mData } = await supabase
                .from('merchants')
                .select('dba_name')
                .eq('id', merchant_id)
                .maybeSingle();
            if (mData?.dba_name) dba = mData.dba_name;
        }

        const { data: existingRma } = await supabase
            .from('returns')
            .select('return_reason')
            .eq('deployment_id', deployment_id)
            .maybeSingle();

        const persistentReason = (existingRma && existingRma.return_reason) ? existingRma.return_reason : notes;

        let rmaStatus = (return_type.includes('Stock') || return_type.includes('Repairs')) ? 'Closed' : 'open';
        let isCompleting = rmaStatus === 'Closed';
        let finalLoc = isCompleting ? (return_type.includes('Repairs') ? 'Warsaw Repairs' : 'Warsaw Office') : 'In Transit / RMA';

        // 2. UPSERT RMA
        await supabase.from('returns').upsert({
            deployment_id,
            equipment_id,
            merchant_id,
            status: rmaStatus,
            condition: return_type,
            destination: finalLoc,
            return_reason: persistentReason
        }, { onConflict: 'deployment_id' });

        // 3. LOG HISTORY (Requirement: Use business name instead of "Merchant Site")
        await supabase.from('equipment_logs').insert([{
            equipment_id,
            merchant_id,
            deployment_id,
            action: isCompleting ? 'RMA_COMPLETED' : 'RMA_INITIATED',
            from_location: isCompleting ? 'In Transit' : dba, // Use DBA here
            to_location: finalLoc,
            notes: `Reason: ${persistentReason}`
        }]);

        // 4. UPDATE EQUIPMENT & DEPLOYMENT
        await supabase.from('equipments').update({ 
            status: isCompleting ? (return_type.includes('Repairs') ? 'repairing' : 'stocked') : 'pending_return', 
            current_location: finalLoc,
            merchant_id: isCompleting ? null : merchant_id 
        }).eq('id', equipment_id);

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
