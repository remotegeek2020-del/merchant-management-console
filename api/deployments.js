import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, payload, query } = body;

    // Resolve actor name once — used for created_by/updated_by and logging
    const { data: actorRow } = await supabase
        .from('app_users')
        .select('email, first_name, last_name, role, can_delete_tickets')
        .eq('userid', session.userid)
        .maybeSingle();
    const actorEmail = actorRow?.email || session.userid;
    const actorName  = actorRow ? `${actorRow.first_name || ''} ${actorRow.last_name || ''}`.trim() || actorRow.email : 'Staff';

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

    const { data: merchantRec0 } = await supabase.from('merchants').select('dba_name').eq('id', merchant_id).single();
    const merchantDba0 = merchantRec0?.dba_name || 'Merchant Site';

    const { data: returnData, error: returnError } = await supabase
        .from('returns')
        .insert([{
            equipment_id,
            merchant_id,
            deployment_id,
            return_reason: reason,
            notes,
            return_date_initiated,
            status: 'Open',
            created_by: session.userid
        }])
        .select('id, return_id')
        .single();

    if (returnError) throw returnError;

    await supabase.from('equipment_logs').insert([{
        equipment_id,
        merchant_id,
        action: 'return_initiated',
        from_location: merchantDba0,
        to_location: 'In Transit',
        notes: `Return initiated: ${reason}`
    }]);

    const { data: lrActorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const lrActorEmail = lrActorRow?.email || session.userid;
    const lrActorName  = lrActorRow ? `${lrActorRow.first_name || ''} ${lrActorRow.last_name || ''}`.trim() || lrActorRow.email : 'Staff';
    const { data: lrEquip } = await supabase.from('equipments').select('serial_number, terminal_type').eq('id', equipment_id).maybeSingle();
    supabase.from('activity_logs').insert({
        email: lrActorEmail,
        action: `RMA Filed by ${lrActorName} — ${returnData?.return_id || 'RMA'} — ${lrEquip?.serial_number || equipment_id} (${merchantDba0})`,
        status: 'success', category: 'returns',
        target_id: returnData?.return_id || equipment_id, target_type: 'return',
        severity: 'info',
        old_value: { status: 'deployed', merchant: merchantDba0, serial_number: lrEquip?.serial_number },
        new_value: { return_id: returnData?.return_id, status: 'Open', return_reason: reason, return_date: return_date_initiated, created_by: lrActorName }
    }).then(() => {}).catch(() => {});

    return res.status(200).json({ success: true });
}

        if (action === 'complete_rma') {
    const {
        return_id,
        equipment_id,
        destination,
        equipment_received_date
    } = payload;

    const { error: updateReturnError } = await supabase
        .from('returns')
        .update({
            status: 'Closed',
            destination,
            equipment_received_date
        })
        .eq('id', return_id);

    if (updateReturnError) throw updateReturnError;

    const { data: returnRecord } = await supabase
        .from('returns')
        .select('merchant_id')
        .eq('id', return_id)
        .single();

    const recovered_merchant_id = returnRecord?.merchant_id || null;

    const { error: equipError } = await supabase
        .from('equipments')
        .update({
            status: 'stocked',
            current_location: destination,
            merchant_id: null
        })
        .eq('id', equipment_id);

    if (equipError) throw equipError;

    await supabase.from('equipment_logs').insert([{
        equipment_id,
        merchant_id: recovered_merchant_id,
        action: 'rma_completed',
        from_location: 'In Transit',
        to_location: destination,
        notes: `RMA Closed. Received on ${equipment_received_date}`
    }]);

    const { data: crActorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const crActorEmail = crActorRow?.email || session.userid;
    const crActorName  = crActorRow ? `${crActorRow.first_name || ''} ${crActorRow.last_name || ''}`.trim() || crActorRow.email : 'Staff';
    const { data: crEquip } = await supabase.from('equipments').select('serial_number, terminal_type').eq('id', equipment_id).maybeSingle();
    supabase.from('activity_logs').insert({
        email: crActorEmail,
        action: `RMA Completed by ${crActorName} — ${crEquip?.serial_number || equipment_id} → ${destination}`,
        status: 'success', category: 'returns',
        target_id: crEquip?.serial_number || equipment_id, target_type: 'equipment',
        severity: destination === 'Scrap' ? 'warning' : 'info',
        old_value: { status: 'in_transit', return_id },
        new_value: { status: 'stocked', destination, equipment_received_date }
    }).then(() => {}).catch(() => {});

    return res.status(200).json({ success: true });
}

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
        console.error('[API Error]', error.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
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

if (action === 'update') {
    const {
        deployment_id,
        status,
        tracking_id,
        target_date,
        notes,
        purchase_type,
        merchant_received_date
    } = payload;

    const { data: oldDep, error: fetchError } = await supabase
        .from('deployments')
        .select('status, tracking_id, equipment_id, merchant_id, merchants:merchant_id(dba_name)')
        .eq('id', deployment_id)
        .single();

    if (fetchError || !oldDep) {
        return res.status(404).json({ success: false, message: "Deployment ticket not found." });
    }

    const { error: updateError } = await supabase
        .from('deployments')
        .update({
            status,
            tracking_id,
            target_deployment_date: target_date,
            notes,
            purchase_type,
            merchant_received_date: merchant_received_date || null,
            updated_by: session.userid
        })
        .eq('id', deployment_id);

    if (updateError) throw updateError;

    if (oldDep.status !== status || oldDep.tracking_id !== tracking_id) {
        await supabase.from('equipment_logs').insert([{
            equipment_id: oldDep.equipment_id,
            merchant_id: oldDep.merchant_id,
            deployment_id: deployment_id,
            action: 'TICKET_UPDATED',
            from_location: oldDep.merchants?.dba_name || 'Merchant Site',
            to_location: oldDep.merchants?.dba_name || 'Merchant Site',
            notes: `Status changed to ${status}. Purchase Type: ${purchase_type || 'N/A'}`
        }]);
    }

    supabase.from('activity_logs').insert({
        email: actorEmail,
        action: `Deployment Updated — ${oldDep.merchants?.dba_name || deployment_id} (${oldDep.status} → ${status})`,
        status: 'success', category: 'deployments', target_id: deployment_id, target_type: 'deployment', severity: 'info',
        old_value: { status: oldDep.status, tracking_id: oldDep.tracking_id },
        new_value: { status, tracking_id: tracking_id || null, purchase_type: purchase_type || null, target_date: target_date || null, merchant_received_date: merchant_received_date || null, notes: notes || null }
    }).then(() => {}).catch(e => console.warn('[ActivityLog]', e.message));

    return res.status(200).json({ success: true });
}

if (action === 'check_rma') {
    const { deployment_id } = body.payload;

    // For bulk deployments: return per-item deployment status instead of a single return record
    const { data: dep } = await supabase.from('deployments')
        .select('is_bulk').eq('id', deployment_id).single();

    if (dep?.is_bulk) {
        const { data: depItems } = await supabase.from('deployment_items')
            .select('equipment_id, equip:equipment_id(status)')
            .eq('deployment_id', deployment_id);

        const deployedCount = (depItems || []).filter(i => i.equip?.status === 'deployed').length;
        const totalCount = depItems?.length || 0;

        // Check if any open return exists (in-progress indicator)
        const { data: openReturn } = await supabase.from('returns')
            .select('return_id, id, status, return_reason')
            .eq('deployment_id', deployment_id)
            .eq('status', 'Open')
            .limit(1)
            .maybeSingle();

        // Build map: equipment_id → RMA display ID for completed returns
        const returnedEquipMap = {};
        const { data: closedReturns } = await supabase.from('returns')
            .select('id, return_id')
            .eq('deployment_id', deployment_id)
            .eq('status', 'Closed');

        if (closedReturns?.length) {
            const closedIds = closedReturns.map(r => r.id);
            const rmaIdByRow = {};
            closedReturns.forEach(r => { rmaIdByRow[r.id] = r.return_id; });

            const { data: retItems } = await supabase.from('return_items')
                .select('equipment_id, return_id')
                .in('return_id', closedIds);

            (retItems || []).forEach(ri => {
                returnedEquipMap[ri.equipment_id] = rmaIdByRow[ri.return_id] || null;
            });
        }

        return res.status(200).json({
            success: true,
            data: openReturn || null,
            isBulk: true,
            deployedCount,
            totalCount,
            returnedEquipMap
        });
    }

    // Single unit: original logic
    const { data } = await supabase
        .from('returns')
        .select('return_id, id, status, return_reason')
        .eq('deployment_id', deployment_id)
        .maybeSingle();

    return res.status(200).json({ success: true, data: data || null });
}

if (action === 'delete') {
    const { deployment_id, equipment_id, merchant_id, merchant_name, serial_number } = payload || {};

    if (!deployment_id) {
        return res.status(400).json({ success: false, message: "Missing Deployment ID" });
    }

    if (actorRow?.role !== 'super_admin' && !actorRow?.can_delete_tickets) {
        return res.status(403).json({ success: false, message: 'You do not have permission to delete deployments.' });
    }

    try {
        // 1. DELETE LINKED RMA FIRST (cascade handles return_items)
        const { error: rmaDeleteError } = await supabase
            .from('returns')
            .delete()
            .eq('deployment_id', deployment_id);

        if (rmaDeleteError) throw rmaDeleteError;

        // 2. Reset Equipment status — single or bulk
        if (equipment_id && equipment_id !== 'null') {
            // Single unit
            await supabase.from('equipments').update({
                status: 'stocked',
                current_location: 'Warsaw Office',
                merchant_id: null
            }).eq('id', equipment_id);

            await supabase.from('equipment_logs').insert([{
                equipment_id: equipment_id,
                merchant_id: merchant_id,
                action: 'TICKET_DELETED',
                from_location: merchant_name || 'Merchant Site',
                to_location: 'Warsaw Office',
                notes: `Ticket ${deployment_id} deleted. Unit reset to stock.`
            }]);
        } else {
            // Bulk: reset all deployment_items equipment
            const { data: depItems } = await supabase
                .from('deployment_items')
                .select('equipment_id')
                .eq('deployment_id', deployment_id);

            for (const item of (depItems || [])) {
                await supabase.from('equipments').update({
                    status: 'stocked',
                    current_location: 'Warsaw Office',
                    merchant_id: null
                }).eq('id', item.equipment_id);

                await supabase.from('equipment_logs').insert([{
                    equipment_id: item.equipment_id,
                    merchant_id: merchant_id,
                    action: 'TICKET_DELETED',
                    from_location: merchant_name || 'Merchant Site',
                    to_location: 'Warsaw Office',
                    notes: `Bulk ticket ${deployment_id} deleted. Unit reset to stock.`
                }]);
            }
            // deployment_items cascade-deleted when deployment is deleted
        }

        // 3. DELETE THE DEPLOYMENT
        const { error: deleteError } = await supabase
            .from('deployments')
            .delete()
            .eq('id', deployment_id);

        if (deleteError) throw deleteError;

        supabase.from('activity_logs').insert({
            email: actorEmail,
            action: `Deployment Deleted — ${merchant_name || 'Unknown Merchant'} (${serial_number || 'bulk'}) [${deployment_id}]`,
            status: 'success', category: 'deployments', target_id: deployment_id, target_type: 'deployment', severity: 'warning',
            old_value: { deployment_id, merchant: merchant_name, serial_number: serial_number || null, equipment_id: equipment_id || null, merchant_id: merchant_id || null }
        }).then(() => {}).catch(e => console.warn('[ActivityLog]', e.message));

        return res.status(200).json({ success: true });

    } catch (err) {
        console.error('[API Error]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
    }
}

        if (action === 'list') {
            const { query, page = 1, limit = 20, dateFrom, dateTo, statusFilter, purchaseTypeFilter } = body;
            const from = (page - 1) * limit;
            const to = from + limit - 1;

            let request = supabase
                .from('deployments')
                .select(`
                    *,
                    merchants:merchant_id(dba_name, merchant_id, merchant_city, merchant_state, merchant_phone, email, agent_id, agent_name),
                    equipments:equipment_id(id, serial_number, terminal_type),
                    deployment_items(id, equipment_id, tid, equip:equipment_id(serial_number, terminal_type, status))
                `, { count: 'exact' });

            if (dateFrom) request = request.gte('target_deployment_date', dateFrom);
            if (dateTo) request = request.lte('target_deployment_date', dateTo + 'T23:59:59');
            if (statusFilter) request = request.eq('status', statusFilter);
            if (purchaseTypeFilter) request = request.eq('purchase_type', purchaseTypeFilter);

            if (query) {
                const term = `%${query}%`;

                // Parallel lookups for joined-table fields
                const [merchantRes, equipRes, tidItemsRes] = await Promise.all([
                    supabase.from('merchants').select('id').ilike('dba_name', term),
                    supabase.from('equipments').select('id').or(`serial_number.ilike.${term},terminal_type.ilike.${term}`),
                    supabase.from('deployment_items').select('deployment_id').ilike('tid', term)
                ]);

                const merchantIds = (merchantRes.data || []).map(m => m.id);
                const equipIds    = (equipRes.data    || []).map(e => e.id);
                // Deployment IDs found via TID on items
                let bulkDepIds = [...new Set((tidItemsRes.data || []).map(d => d.deployment_id))];

                // Also collect bulk deployment IDs that contain matching equipment
                if (equipIds.length > 0) {
                    const { data: bulkDeps } = await supabase
                        .from('deployment_items').select('deployment_id').in('equipment_id', equipIds);
                    const extra = (bulkDeps || []).map(d => d.deployment_id);
                    bulkDepIds = [...new Set([...bulkDepIds, ...extra])];
                }

                const conditions = [`deployment_id.ilike.${term}`, `tid.ilike.${term}`, `tracking_id.ilike.${term}`];
                if (merchantIds.length > 0) conditions.push(`merchant_id.in.(${merchantIds.join(',')})`);
                if (equipIds.length > 0)   conditions.push(`equipment_id.in.(${equipIds.join(',')})`);
                if (bulkDepIds.length > 0) conditions.push(`id.in.(${bulkDepIds.join(',')})`);
                request = request.or(conditions.join(','));
            }

            const { data, error, count } = await request
                .order('created_at', { ascending: false })
                .range(from, to);

            if (error) throw error;

            const { count: activeCount } = await supabase
                .from('deployments')
                .select('*', { count: 'exact', head: true })
                .in('status', ['Open', 'In Transit']);

            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);
            const { count: todayCount } = await supabase
                .from('deployments')
                .select('*', { count: 'exact', head: true })
                .gte('created_at', startOfDay.toISOString());

            // Resolve created_by / updated_by userids → display names
            const userIds = [...new Set((data || []).flatMap(d => [d.created_by, d.updated_by].filter(Boolean)))];
            let userMap = {};
            if (userIds.length) {
                const { data: users } = await supabase.from('app_users')
                    .select('userid, first_name, last_name')
                    .in('userid', userIds);
                userMap = Object.fromEntries((users || []).map(u => [
                    u.userid,
                    `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.userid
                ]));
            }

            // Normalize to items[] for unified frontend handling
            const safeData = (data || []).map(d => {
                d.items = d.is_bulk
                    ? (d.deployment_items || []).map(i => ({ equipment_id: i.equipment_id, tid: i.tid, serial_number: i.equip?.serial_number, terminal_type: i.equip?.terminal_type, status: i.equip?.status, item_id: i.id }))
                    : (d.equipment_id ? [{ equipment_id: d.equipment_id, tid: d.tid, serial_number: d.equipments?.serial_number, terminal_type: d.equipments?.terminal_type, item_id: null }] : []);
                d.created_by_name = d.created_by ? (userMap[d.created_by] || null) : null;
                d.updated_by_name = d.updated_by ? (userMap[d.updated_by] || null) : null;
                return d;
            });

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

if (action === 'create') {
    const {
        merchant_id,
        equipment_id,
        tid,
        tracking_id,
        target_date,
        notes,
        purchase_type,
        is_bulk,
        items,
        ship_to_type,
        ship_to_partner_id,
        merchant_updates,
        partner_updates
    } = payload;

    // Shipping destination distinction (additive — defaults to 'merchant')
    const shipType = ship_to_type === 'partner' ? 'partner' : 'merchant';
    const shipPartnerId = shipType === 'partner' ? (ship_to_partner_id || null) : null;

    // Save-back: persist any newly-entered contact/address to the merchant/partner
    // record. Server-side whitelist so only contact fields can be written.
    const MERCHANT_SAVE_FIELDS = ['dba_name','email','merchant_primary_contact','merchant_phone','merchant_address','merchant_city','merchant_state','merchant_zip','merchant_country'];
    const PARTNER_SAVE_FIELDS  = ['full_name','email','phone_number','address','city','state','zip','country'];
    const doShipSaveback = async () => {
        try {
            if (merchant_updates && typeof merchant_updates === 'object') {
                const safe = Object.fromEntries(Object.entries(merchant_updates)
                    .filter(([k, v]) => MERCHANT_SAVE_FIELDS.includes(k) && v != null && String(v).trim() !== ''));
                if (Object.keys(safe).length) await supabase.from('merchants').update(safe).eq('id', merchant_id);
            }
            if (partner_updates && shipPartnerId && typeof partner_updates === 'object') {
                const safe = Object.fromEntries(Object.entries(partner_updates)
                    .filter(([k, v]) => PARTNER_SAVE_FIELDS.includes(k) && v != null && String(v).trim() !== ''));
                if (Object.keys(safe).length) await supabase.from('persons').update(safe).eq('id', shipPartnerId);
            }
        } catch (e) { console.warn('[ShipSaveback]', e.message); }
    };

    // --- BULK MODE ---
    if (is_bulk && Array.isArray(items) && items.length > 0) {
        const { data: merchantData } = await supabase
            .from('merchants').select('dba_name').eq('id', merchant_id).single();
        const dbaName = merchantData?.dba_name || 'Client Site';

        // Verify all equipment is stocked
        for (const item of items) {
            const { data: equip } = await supabase
                .from('equipments').select('status, serial_number').eq('id', item.equipment_id).single();
            if (!equip || equip.status !== 'stocked') {
                return res.status(400).json({ success: false, message: `Equipment ${equip?.serial_number || item.equipment_id} is not available (${equip?.status || 'not found'}).` });
            }
        }

        const { data: dep, error: depErr } = await supabase.from('deployments').insert({
            merchant_id,
            equipment_id: null,
            is_bulk: true,
            tracking_id,
            target_deployment_date: target_date,
            notes,
            purchase_type,
            status: 'Open',
            ship_to_type: shipType,
            ship_to_partner_id: shipPartnerId,
            created_by: session.userid
        }).select().single();
        if (depErr) throw depErr;

        const { error: itemsErr } = await supabase.from('deployment_items').insert(
            items.map(i => ({ deployment_id: dep.id, equipment_id: i.equipment_id, tid: i.tid || null }))
        );
        if (itemsErr) throw itemsErr;

        for (const item of items) {
            await supabase.from('equipments').update({
                status: 'deployed', current_location: dbaName, merchant_id
            }).eq('id', item.equipment_id).eq('status', 'stocked');
        }

        await supabase.from('equipment_logs').insert(
            items.map(i => ({
                equipment_id: i.equipment_id, merchant_id, deployment_id: dep.id,
                action: 'Deployed', from_location: 'Warsaw Office', to_location: dbaName,
                notes: `Bulk deployment. TID: ${i.tid || 'N/A'}. Type: ${purchase_type || 'N/A'}`
            }))
        );

        // Fetch serials for the log
        const { data: itemEquips } = await supabase.from('equipments')
            .select('id, serial_number, terminal_type').in('id', items.map(i => i.equipment_id));
        const equipMap = Object.fromEntries((itemEquips || []).map(e => [e.id, e]));

        supabase.from('activity_logs').insert({
            email: actorEmail,
            action: `Deployment Created — Bulk (${items.length} units) for ${dbaName}`,
            status: 'success', category: 'deployments', target_id: dep.id, target_type: 'deployment', severity: 'info',
            new_value: {
                deployment_id: dep.id,
                merchant_id, merchant_name: dbaName,
                mode: 'bulk', unit_count: items.length,
                units: items.map(i => ({ serial_number: equipMap[i.equipment_id]?.serial_number, terminal_type: equipMap[i.equipment_id]?.terminal_type, tid: i.tid || null })),
                tracking_id: tracking_id || null, purchase_type: purchase_type || null,
                target_date: target_date || null, notes: notes || null,
                ship_to_type: shipType, ship_to_partner_id: shipPartnerId
            }
        }).then(() => {}).catch(e => console.warn('[ActivityLog]', e.message));

        await doShipSaveback();
        return res.status(200).json({ success: true, data: [dep] });
    }

    // --- SINGLE UNIT MODE ---
    const { data: checkEquip, error: checkError } = await supabase
        .from('equipments')
        .select('status, serial_number')
        .eq('id', equipment_id)
        .single();

    if (checkError || !checkEquip) throw new Error("Equipment not found.");

    if (checkEquip.status !== 'stocked') {
        return res.status(400).json({
            success: false,
            message: `Conflict: Serial ${checkEquip.serial_number} was just deployed by another user.`
        });
    }

    const { data: merchantData } = await supabase
        .from('merchants')
        .select('dba_name')
        .eq('id', merchant_id)
        .single();

    const dbaName = merchantData?.dba_name || 'Client Site';

    const { data: newDep, error: depError } = await supabase
        .from('deployments')
        .insert([{
            merchant_id,
            equipment_id,
            tid,
            tracking_id,
            target_deployment_date: target_date,
            notes,
            purchase_type,
            status: 'Open',
            ship_to_type: shipType,
            ship_to_partner_id: shipPartnerId,
            created_by: session.userid
        }])
        .select();

    if (depError) throw depError;

    const { data: updateResult, error: updateEquipError } = await supabase.from('equipments')
        .update({ status: 'deployed', current_location: dbaName, merchant_id })
        .eq('id', equipment_id)
        .eq('status', 'stocked')
        .select('id');

    if (updateEquipError || !updateResult || updateResult.length === 0) {
        await supabase.from('deployments').delete().eq('id', newDep[0]?.id);
        return res.status(409).json({ success: false, message: `Conflict: Serial ${checkEquip.serial_number} was just deployed by another user. Please refresh and try again.` });
    }

    await supabase.from('equipment_logs').insert([{
        equipment_id,
        merchant_id,
        action: 'Deployed',
        from_location: 'Warsaw Office',
        to_location: dbaName,
        notes: `Deployment Created. Type: ${purchase_type || 'N/A'}`
    }]);

    supabase.from('activity_logs').insert({
        email: actorEmail,
        action: `Deployment Created — ${dbaName} (${checkEquip.serial_number})`,
        status: 'success', category: 'deployments', target_id: newDep[0]?.id, target_type: 'deployment', severity: 'info',
        new_value: {
            deployment_id: newDep[0]?.id,
            merchant_id, merchant_name: dbaName,
            mode: 'single',
            serial_number: checkEquip.serial_number,
            equipment_id, tid: tid || null,
            tracking_id: tracking_id || null, purchase_type: purchase_type || null,
            target_date: target_date || null, notes: notes || null,
            ship_to_type: shipType, ship_to_partner_id: shipPartnerId
        }
    }).then(() => {}).catch(e => console.warn('[ActivityLog]', e.message));

    await doShipSaveback();
    return res.status(200).json({ success: true, data: newDep });
}

if (action === 'return_to_office') {
    const {
        equipment_id,
        merchant_id,
        deployment_id,
        return_type,
        notes,
        return_date_initiated,
        equipment_received_date,
        selected_equipment_ids
    } = req.body.payload;

    try {
        const isBulk = !equipment_id || equipment_id === 'null';

        if (return_type === 'In Transit') {
            if (isBulk) {
                // BULK: get deployment items, optionally filtered to selected units
                let depItemsQuery = supabase
                    .from('deployment_items')
                    .select('equipment_id')
                    .eq('deployment_id', deployment_id);
                if (selected_equipment_ids?.length) {
                    depItemsQuery = depItemsQuery.in('equipment_id', selected_equipment_ids);
                }
                const { data: depItems } = await depItemsQuery;

                // INSERT (not upsert) — bulk deployments can have multiple partial returns
                const { data: ret, error: retErr } = await supabase.from('returns').insert({
                    deployment_id,
                    equipment_id: null,
                    merchant_id,
                    return_reason: notes,
                    return_date_initiated,
                    condition: 'IN TRANSIT',
                    destination: 'In Transit / RMA',
                    status: 'Open',
                    is_bulk: true,
                    created_by: session.userid
                }).select().single();
                if (retErr) throw retErr;

                // Delete any existing return_items for this return and re-insert
                await supabase.from('return_items').delete().eq('return_id', ret.id);
                if (depItems?.length) {
                    await supabase.from('return_items').insert(
                        depItems.map(di => ({ return_id: ret.id, equipment_id: di.equipment_id, condition: 'IN TRANSIT' }))
                    );
                }

                const { data: mRec } = await supabase.from('merchants').select('dba_name').eq('id', merchant_id).single();
                const mDba = mRec?.dba_name || 'Merchant Site';

                if (depItems?.length) {
                    await supabase.from('equipment_logs').insert(
                        depItems.map(di => ({
                            equipment_id: di.equipment_id, merchant_id, deployment_id,
                            action: 'RMA Initiated', from_location: mDba, to_location: 'In Transit / RMA',
                            notes: `Bulk RMA Initiated. Reason: ${notes || 'N/A'}`
                        }))
                    );
                }
                await supabase.from('activity_logs').insert({
                    email: actorEmail,
                    action: `RMA Filed by ${actorName} — ${ret?.return_id || 'RMA'} — Bulk (${depItems?.length || 0} units) from ${mDba}`,
                    status: 'success', category: 'returns', target_id: ret?.return_id || deployment_id, target_type: 'return', severity: 'info',
                    old_value: { deployment_id, merchant: mDba, unit_count: depItems?.length || 0 },
                    new_value: { return_id: ret?.return_id, status: 'Open', destination: 'In Transit / RMA', return_reason: notes || null, return_date_initiated, created_by: actorName }
                });
            } else {
                // SINGLE: capture returned row so we can use return_id in the activity log
                const { data: singleRet, error: singleRetErr } = await supabase.from('returns').insert({
                    deployment_id,
                    equipment_id,
                    merchant_id,
                    return_reason: notes,
                    return_date_initiated,
                    condition: 'IN TRANSIT',
                    destination: 'In Transit / RMA',
                    status: 'Open',
                    created_by: session.userid
                }).select('id, return_id').single();
                if (singleRetErr) throw singleRetErr;

                const { data: mRecSingle } = await supabase.from('merchants').select('dba_name').eq('id', merchant_id).single();
                const mDbaSingle = mRecSingle?.dba_name || 'Merchant Site';

                await supabase.from('equipment_logs').insert([{
                    equipment_id, merchant_id, deployment_id,
                    action: 'RMA Initiated',
                    from_location: mDbaSingle,
                    to_location: 'In Transit / RMA',
                    notes: `Unit marked In Transit. Reason: ${notes || 'N/A'}`
                }]);
                await supabase.from('activity_logs').insert({
                    email: actorEmail,
                    action: `RMA Filed by ${actorName} — ${singleRet?.return_id || 'RMA'} — Single unit from ${mDbaSingle}`,
                    status: 'success', category: 'returns', target_id: singleRet?.return_id || deployment_id, target_type: 'return', severity: 'info',
                    old_value: { deployment_id, merchant: mDbaSingle, equipment_id },
                    new_value: { return_id: singleRet?.return_id, status: 'Open', destination: 'In Transit / RMA', return_reason: notes || null, return_date_initiated, created_by: actorName }
                });
            }

        } else {
            // STEP 2: COMPLETE RMA
            let finalCondition = '';
            let finalDestination = '';

            if (return_type === 'Working (Back to Stock)') {
                finalCondition = 'Working (Back to Stock)';
                finalDestination = 'Warsaw Office';
            } else {
                finalCondition = 'Defective (Received in Repairs)';
                finalDestination = 'Warsaw Repairs';
            }

            if (isBulk) {
                // Find the most recent open return for this deployment
                const { data: openRets } = await supabase.from('returns')
                    .select('id').eq('deployment_id', deployment_id).eq('status', 'Open')
                    .order('created_at', { ascending: false }).limit(1);
                const retRecord = openRets?.[0];
                if (!retRecord) throw new Error('No open return found for this deployment');

                const { data: retItems } = await supabase.from('return_items')
                    .select('equipment_id').eq('return_id', retRecord.id);

                for (const ri of (retItems || [])) {
                    await supabase.from('equipments').update({
                        status: finalCondition.includes('Working') ? 'stocked' : 'repairing',
                        current_location: finalDestination,
                        merchant_id: null
                    }).eq('id', ri.equipment_id);
                }

                // Close only the specific return being processed
                await supabase.from('returns').update({
                    status: 'Closed',
                    condition: finalCondition,
                    destination: finalDestination,
                    equipment_received_date
                }).eq('id', retRecord.id);

                // Update per-item condition
                await supabase.from('return_items').update({ condition: finalCondition }).eq('return_id', retRecord.id);

                // Only close deployment if all units across all RMAs are returned
                const { count: totalItems } = await supabase.from('deployment_items')
                    .select('id', { count: 'exact', head: true }).eq('deployment_id', deployment_id);
                const { data: closedRets } = await supabase.from('returns')
                    .select('id').eq('deployment_id', deployment_id).eq('status', 'Closed');
                let returnedCount = 0;
                for (const cr of (closedRets || [])) {
                    const { count } = await supabase.from('return_items')
                        .select('id', { count: 'exact', head: true }).eq('return_id', cr.id);
                    returnedCount += count || 0;
                }
                if (totalItems > 0 && returnedCount >= totalItems) {
                    await supabase.from('deployments').update({ status: 'Closed' }).eq('id', deployment_id);
                }

                if (retItems?.length) {
                    await supabase.from('equipment_logs').insert(
                        retItems.map(ri => ({
                            equipment_id: ri.equipment_id, merchant_id, deployment_id,
                            action: 'RMA Completed',
                            from_location: 'In Transit / RMA',
                            to_location: finalDestination,
                            notes: `Bulk RMA Closed. ${finalCondition}. Received: ${equipment_received_date || 'N/A'}`
                        }))
                    );
                }
                supabase.from('activity_logs').insert({
                    email: actorEmail,
                    action: `RMA Completed by ${actorName} — Bulk (${retItems?.length || 0} units) → ${finalDestination}`,
                    status: 'success', category: 'returns', target_id: deployment_id, target_type: 'deployment',
                    severity: finalDestination === 'Scrap' ? 'warning' : 'info',
                    old_value: { deployment_id, status: 'Open', destination: 'In Transit / RMA' },
                    new_value: { status: 'Closed', condition: finalCondition, destination: finalDestination, unit_count: retItems?.length || 0, equipment_received_date: equipment_received_date || null }
                }).then(() => {}).catch(() => {});
            } else {
                // SINGLE: existing logic
                const { error: returnUpdateError } = await supabase.from('returns').update({
                    status: 'Closed',
                    condition: finalCondition,
                    destination: finalDestination,
                    equipment_received_date
                }).eq('deployment_id', deployment_id);
                if (returnUpdateError) throw returnUpdateError;

                await supabase.from('equipments').update({
                    status: finalCondition.includes('Working') ? 'stocked' : 'repairing',
                    current_location: finalDestination,
                    merchant_id: null
                }).eq('id', equipment_id);

                await supabase.from('equipment_logs').insert([{
                    equipment_id, merchant_id, deployment_id,
                    action: 'RMA Completed',
                    from_location: 'In Transit / RMA',
                    to_location: finalDestination,
                    notes: `Inspection finished. Unit marked as ${finalCondition}. Received: ${equipment_received_date || 'N/A'}`
                }]);
                supabase.from('activity_logs').insert({
                    email: actorEmail,
                    action: `RMA Completed by ${actorName} — Single unit → ${finalDestination}`,
                    status: 'success', category: 'returns', target_id: deployment_id, target_type: 'deployment',
                    severity: finalDestination === 'Scrap' ? 'warning' : 'info',
                    old_value: { deployment_id, equipment_id, status: 'Open', destination: 'In Transit / RMA' },
                    new_value: { status: 'Closed', condition: finalCondition, destination: finalDestination, equipment_received_date: equipment_received_date || null }
                }).then(() => {}).catch(() => {});
            }
        }

        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('[API Error]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
    }
}

if (action === 'bulk_validate') {
    const items = payload; // array of { serial_number, merchant_id, tid }
    const results = [];

    for (const item of (items || [])) {
        const { data: equip } = await supabase.from('equipments')
            .select('id, serial_number, status')
            .eq('serial_number', item.serial_number)
            .maybeSingle();

        const { data: merchant } = await supabase.from('merchants')
            .select('id, dba_name')
            .eq('merchant_id', item.merchant_id)
            .maybeSingle();

        let message = 'Ready';
        if (!equip) message = 'Serial not found';
        else if (equip.status !== 'stocked') message = `Not available (${equip.status})`;
        else if (!merchant) message = 'Merchant ID not found';

        results.push({
            serial_number: item.serial_number,
            merchant_id: item.merchant_id,
            tid: item.tid || null,
            equipment_id: equip?.id || null,
            merchant_uuid: merchant?.id || null,
            merchant_dba: merchant?.dba_name || null,
            status: equip?.status || null,
            merchantExists: !!merchant,
            message
        });
    }

    return res.status(200).json({ success: true, validationResults: results });
}

if (action === 'bulk_create') {
    const validItems = payload; // filtered valid rows from bulk_validate

    // Group by merchant UUID
    const groups = {};
    for (const item of (validItems || [])) {
        const key = item.merchant_uuid;
        if (!groups[key]) groups[key] = { merchant_uuid: item.merchant_uuid, merchant_dba: item.merchant_dba, items: [] };
        groups[key].items.push(item);
    }

    let totalCreated = 0;

    for (const group of Object.values(groups)) {
        const { data: dep, error: depErr } = await supabase.from('deployments').insert({
            merchant_id: group.merchant_uuid,
            equipment_id: null,
            is_bulk: true,
            status: 'Open',
            notes: `Bulk deployment: ${group.items.length} units`,
            target_deployment_date: new Date().toISOString().split('T')[0],
            created_by: session.userid
        }).select().single();
        if (depErr) throw depErr;

        const { error: itemsErr } = await supabase.from('deployment_items').insert(
            group.items.map(i => ({ deployment_id: dep.id, equipment_id: i.equipment_id, tid: i.tid || null }))
        );
        if (itemsErr) throw itemsErr;

        for (const item of group.items) {
            await supabase.from('equipments').update({
                status: 'deployed',
                current_location: group.merchant_dba,
                merchant_id: group.merchant_uuid
            }).eq('id', item.equipment_id).eq('status', 'stocked');
        }

        await supabase.from('equipment_logs').insert(
            group.items.map(i => ({
                equipment_id: i.equipment_id,
                merchant_id: group.merchant_uuid,
                deployment_id: dep.id,
                action: 'Deployed',
                from_location: 'Warsaw Office',
                to_location: group.merchant_dba,
                notes: `Bulk deployment created via CSV. TID: ${i.tid || 'N/A'}`
            }))
        );

        totalCreated += group.items.length;
    }

    try {
        await supabase.from('activity_logs').insert({
            email: actorEmail,
            action: `Bulk Upload Deployments — ${totalCreated} units deployed`,
            status: 'success',
            category: 'deployments',
            target_type: 'deployment',
            severity: 'info',
            new_value: { count: totalCreated, merchant_groups: Object.keys(groups).length }
        });
    } catch (logErr) {
        console.warn('Activity log failed:', logErr.message);
    }

    return res.status(200).json({ success: true, count: totalCreated });
}

// ── SHIP INFO ─────────────────────────────────────────────────────────────
// Returns merchant contact/address + the merchant's partner (auto-resolved via
// agent_id chain). Powers auto-fill of the shipping destination in the modal.
if (action === 'getShipInfo') {
    const { merchant_id } = body;
    if (!merchant_id) return res.status(400).json({ success: false, message: 'merchant_id required' });

    const { data: m } = await supabase
        .from('merchants')
        .select('id, dba_name, merchant_id, agent_id, agent_name, email, merchant_primary_contact, merchant_phone, merchant_address, merchant_city, merchant_state, merchant_zip, merchant_country')
        .eq('id', merchant_id)
        .maybeSingle();

    // Resolve partner: merchants.agent_id → agent_identifiers.id_string →
    // agents.id → agents.parent_agent_id → persons.id  (sequential = robust)
    let partner = null;
    if (m?.agent_id) {
        const { data: ai } = await supabase.from('agent_identifiers')
            .select('agent_id').eq('id_string', m.agent_id).maybeSingle();
        if (ai?.agent_id) {
            const { data: ag } = await supabase.from('agents')
                .select('parent_agent_id').eq('id', ai.agent_id).maybeSingle();
            if (ag?.parent_agent_id) {
                const { data: p } = await supabase.from('persons')
                    .select('id, full_name, email, phone_number, address, city, state, zip, country')
                    .eq('id', ag.parent_agent_id).maybeSingle();
                if (p) partner = p;
            }
        }
    }

    return res.status(200).json({ success: true, merchant: m, partner });
}

if (action === 'getLookups') {
    const term = `%${query || ''}%`;

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

        if (action === 'getHistory') {
            const ids = body.equipment_ids || (body.equipment_id ? [body.equipment_id] : []);
            if (!ids.length) return res.status(400).json({ success: false, message: 'No equipment_id provided' });
            const { data, error } = await supabase.from('equipment_logs').select('*').in('equipment_id', ids).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error('[API Error]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
    }
}
