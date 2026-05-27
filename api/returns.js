
import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');

    try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !supabaseKey) return res.status(500).json({ success: false, message: "Env variables missing" });

        const supabase = createClient(supabaseUrl, supabaseKey);
        const body = req.body || {};
        const { action, id, payload, query } = body;

if (action === 'getMonthlyReport') {
    const { startDate, endDate, offset = 0, limit = 1000 } = req.body;

    const { data, error, count } = await supabase
        .from('returns')
        .select(`
            return_id,
            return_reason,
            status,
            return_date_initiated,
            merchants:merchant_id (
                dba_name,
                merchant_id
            ),
            equipments:equipment_id (serial_number)
        `, { count: 'exact' })
        .gte('return_date_initiated', startDate)
        .lte('return_date_initiated', endDate)
        .range(offset, offset + limit - 1);

    if (error) throw error;

    const rawData = data.map(d => ({
        "Return ID": d.return_id,
        "Date Initiated": d.return_date_initiated || '---',
        "Merchant ID": d.merchants?.merchant_id || 'N/A',
        "Merchant Name": d.merchants?.dba_name || 'N/A',
        "Serial": d.equipments?.serial_number || 'N/A',
        "Reason": d.return_reason,
        "Status": d.status
    }));

    return res.status(200).json({ success: true, rawData, totalCount: count });
}

if (action === 'list') {
    const searchQuery = query || '';
    const limit = req.body.limit || 20;
    const offset = req.body.offset || 0;
    const { statusFilter, conditionFilter, reasonFilter, dateFrom, dateTo } = req.body;

    let q = supabase.from('returns').select(`
        id, return_id, return_reason, condition, destination, status, created_at,
        return_date_initiated, equipment_received_date,
        merchant_id, equipment_id, ticket_id, is_bulk,
        merchants:merchant_id (dba_name, merchant_id, merchant_city, merchant_state, merchant_phone, email, agent_id, agent_name),
        equipments:equipment_id (serial_number, terminal_type),
        return_items(id, equipment_id, condition, equip:equipment_id(serial_number, terminal_type))
    `, { count: 'exact' }).order('return_date_initiated', { ascending: false });

    if (searchQuery) {
        const term = `%${searchQuery}%`;

        // Parallel lookups for joined-table fields (merchant name, serial, terminal type)
        const [merchantRes, equipRes] = await Promise.all([
            supabase.from('merchants').select('id').ilike('dba_name', term),
            supabase.from('equipments').select('id').or(`serial_number.ilike.${term},terminal_type.ilike.${term}`)
        ]);

        const merchantIds = (merchantRes.data || []).map(m => m.id);
        const equipIds    = (equipRes.data    || []).map(e => e.id);

        // Also find bulk return IDs whose items match the equipment
        let bulkRetIds = [];
        if (equipIds.length > 0) {
            const { data: bulkRets } = await supabase
                .from('return_items').select('return_id').in('equipment_id', equipIds);
            bulkRetIds = [...new Set((bulkRets || []).map(r => r.return_id))];
        }

        const conditions = [`return_id.ilike.${term}`];
        if (merchantIds.length > 0) conditions.push(`merchant_id.in.(${merchantIds.join(',')})`);
        if (equipIds.length > 0)    conditions.push(`equipment_id.in.(${equipIds.join(',')})`);
        if (bulkRetIds.length > 0)  conditions.push(`id.in.(${bulkRetIds.join(',')})`);
        q = q.or(conditions.join(','));
    }
    if (statusFilter) q = q.ilike('status', statusFilter);
    if (conditionFilter) q = q.ilike('condition', `%${conditionFilter}%`);
    if (reasonFilter) q = q.eq('return_reason', reasonFilter);
    if (dateFrom) q = q.gte('return_date_initiated', dateFrom);
    if (dateTo) q = q.lte('return_date_initiated', dateTo + 'T23:59:59');

    q = q.range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;

    // Normalize to items[] for unified frontend handling
    const normalized = (data || []).map(r => {
        r.items = r.is_bulk
            ? (r.return_items || []).map(i => ({ equipment_id: i.equipment_id, condition: i.condition, serial_number: i.equip?.serial_number, terminal_type: i.equip?.terminal_type, item_id: i.id }))
            : (r.equipment_id ? [{ equipment_id: r.equipment_id, condition: r.condition, serial_number: r.equipments?.serial_number, terminal_type: r.equipments?.terminal_type, item_id: null }] : []);
        return r;
    });

    // Metrics from full dataset, not just current page
    const [{ count: openCount }, { count: defectiveCount }] = await Promise.all([
        supabase.from('returns').select('id', { count: 'exact', head: true }).ilike('status', 'open'),
        supabase.from('returns').select('id', { count: 'exact', head: true }).ilike('condition', '%defective%')
    ]);
    const metrics = { open: openCount || 0, defective: defectiveCount || 0 };

    return res.status(200).json({
        success: true,
        data: normalized,
        metrics,
        count,
        totalCount: count
    });
}

if (action === 'complete_return') {
    const { id: rmaId, equipment_id, condition, destination, merchant_id, equipment_received_date } = payload || {};
    if (!rmaId) throw new Error("Missing RMA ID in payload");

    const { data: actorRow } = await supabase
        .from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const actorEmail = actorRow?.email || session.userid;
    const actorName = actorRow ? `${actorRow.first_name || ''} ${actorRow.last_name || ''}`.trim() || actorRow.email : 'Staff';

    // Fetch the return record
    const { data: rmaData } = await supabase
        .from('returns')
        .select('deployment_id, merchant_id, ticket_id, is_bulk, equipment_id')
        .eq('id', rmaId)
        .single();

    const resolved_merchant_id = merchant_id || rmaData?.merchant_id || null;
    const isBulk = rmaData?.is_bulk || false;
    if (!condition) throw new Error("Missing condition for complete_return");
    const finalStatus = (condition.toLowerCase().includes('working') || destination === 'Warsaw Office') ? 'stocked' : 'repairing';

    if (isBulk) {
        // Process all return_items
        const { data: retItems } = await supabase
            .from('return_items')
            .select('equipment_id')
            .eq('return_id', rmaId);

        for (const ri of (retItems || [])) {
            await supabase.from('equipments').update({
                status: finalStatus, current_location: destination, merchant_id: null
            }).eq('id', ri.equipment_id);
        }

        // Update per-item condition so reports always reflect final state
        await supabase.from('return_items').update({ condition }).eq('return_id', rmaId);

        await supabase.from('equipment_logs').insert(
            (retItems || []).map(ri => ({
                equipment_id: ri.equipment_id,
                merchant_id: resolved_merchant_id,
                action: 'RMA Completed',
                from_location: 'In Transit / RMA',
                to_location: destination,
                notes: `Bulk inspection finished. Unit marked as ${condition}.`
            }))
        );
    } else {
        const actualEquipId = equipment_id || rmaData?.equipment_id;
        if (!actualEquipId) throw new Error("Missing equipment_id for single return");

        await supabase.from('equipments').update({
            status: finalStatus, current_location: destination, merchant_id: null
        }).eq('id', actualEquipId);

        await supabase.from('equipment_logs').insert([{
            equipment_id: actualEquipId,
            merchant_id: resolved_merchant_id,
            action: 'RMA Completed',
            from_location: 'In Transit / RMA',
            to_location: destination,
            notes: `Inspection finished. Unit marked as ${condition}.`
        }]);
    }

    // Close linked deployment — for bulk, only close when ALL units are returned
    if (rmaData?.deployment_id) {
        let shouldClose = true;
        if (isBulk) {
            const { count: totalItems } = await supabase
                .from('deployment_items')
                .select('id', { count: 'exact', head: true })
                .eq('deployment_id', rmaData.deployment_id);

            // Sum return_items across already-closed returns
            const { data: closedRets } = await supabase
                .from('returns')
                .select('id')
                .eq('deployment_id', rmaData.deployment_id)
                .eq('status', 'Closed');
            let returnedCount = 0;
            for (const cr of (closedRets || [])) {
                const { count } = await supabase.from('return_items')
                    .select('id', { count: 'exact', head: true }).eq('return_id', cr.id);
                returnedCount += count || 0;
            }
            // Add current RMA's items (about to be closed)
            const { count: currentItems } = await supabase.from('return_items')
                .select('id', { count: 'exact', head: true }).eq('return_id', rmaId);
            returnedCount += currentItems || 0;

            shouldClose = totalItems > 0 && returnedCount >= totalItems;
        }
        if (shouldClose) {
            await supabase.from('deployments').update({ status: 'Closed' }).eq('id', rmaData.deployment_id);
        }
    }

    // Close the RMA
    const returnUpdate = { status: 'Closed', condition, destination };
    if (equipment_received_date) returnUpdate.equipment_received_date = equipment_received_date;
    await supabase.from('returns').update(returnUpdate).eq('id', rmaId);

    supabase.from('activity_logs').insert({
        email: actorEmail,
        action: `RMA Completed by ${actorName} — ${rmaId} (${condition})`,
        status: 'success', category: 'returns', target_id: rmaId, target_type: 'return', severity: 'info',
        old_value: { status: 'In Transit', rma_id: rmaId },
        new_value: { status: 'Closed', condition, destination, equipment_received_date: equipment_received_date || null, is_bulk: isBulk }
    }).then(() => {}).catch(e => console.warn('[ActivityLog]', e.message));

    // Auto-close linked support ticket
    if (rmaData?.ticket_id) {
        await supabase.from('support_tickets')
            .update({ status: 'closed', updated_at: new Date().toISOString() })
            .eq('id', rmaData.ticket_id);
        await supabase.from('ticket_comments').insert({
            ticket_id: rmaData.ticket_id,
            author_type: 'system',
            author_name: 'System',
            change_summary: `RMA completed. Unit received at ${destination} as ${condition}. Ticket auto-closed.`,
            is_internal: false
        });
    }

    return res.status(200).json({ success: true });
}

        if (action === 'getHistory') {
            const targetId = body.equipment_id;
            const { data, error } = await supabase.from('equipment_logs').select('*').eq('equipment_id', targetId).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'get_addable_items') {
            const { return_display_id } = body;
            if (!return_display_id) return res.status(400).json({ success: false, message: 'return_display_id required.' });

            const { data: rma } = await supabase.from('returns')
                .select('id, status, deployment_id').eq('return_id', return_display_id).single();
            if (!rma) return res.status(404).json({ success: false, message: 'RMA not found.' });
            if (rma.status !== 'Open') return res.status(400).json({ success: false, message: 'RMA is already closed.' });

            const { data: depItems } = await supabase.from('deployment_items')
                .select('equipment_id, equip:equipment_id(id, serial_number, terminal_type, status)')
                .eq('deployment_id', rma.deployment_id);

            const { data: existing } = await supabase.from('return_items')
                .select('equipment_id').eq('return_id', rma.id);
            const existingIds = new Set((existing || []).map(e => e.equipment_id));

            const addable = (depItems || []).filter(di =>
                di.equip?.status === 'deployed' && !existingIds.has(di.equipment_id)
            );

            return res.status(200).json({ success: true, items: addable, rma_uuid: rma.id });
        }

        if (action === 'add_items') {
            const { return_uuid, equipment_ids } = body;
            if (!return_uuid || !equipment_ids?.length) return res.status(400).json({ success: false, message: 'return_uuid and equipment_ids required.' });

            const { data: rma } = await supabase.from('returns')
                .select('id, return_id, status, merchant_id').eq('id', return_uuid).single();
            if (!rma) return res.status(404).json({ success: false, message: 'RMA not found.' });
            if (rma.status !== 'Open') return res.status(400).json({ success: false, message: 'RMA is already closed.' });

            const { data: mRecAdd } = await supabase.from('merchants').select('dba_name').eq('id', rma.merchant_id).single();
            const mDbaAdd = mRecAdd?.dba_name || 'Merchant Site';

            await supabase.from('return_items').insert(
                equipment_ids.map(eqId => ({ return_id: rma.id, equipment_id: eqId, condition: 'IN TRANSIT' }))
            );
            await supabase.from('equipment_logs').insert(
                equipment_ids.map(eqId => ({
                    equipment_id: eqId, merchant_id: rma.merchant_id,
                    action: 'Added to RMA', from_location: mDbaAdd, to_location: 'In Transit / RMA',
                    notes: `Added to existing RMA ${rma.return_id}`
                }))
            );

            return res.status(200).json({ success: true, added: equipment_ids.length });
        }

        if (action === 'delete') {
            const { return_uuid } = body;
            if (!return_uuid) return res.status(400).json({ success: false, message: 'return_uuid required.' });

            const { data: rma, error: fetchErr } = await supabase
                .from('returns')
                .select('id, return_id, equipment_id, merchant_id, is_bulk')
                .eq('id', return_uuid)
                .single();
            if (fetchErr || !rma) return res.status(404).json({ success: false, message: 'Return not found.' });

            // Reset equipment back to stocked
            if (!rma.is_bulk && rma.equipment_id) {
                await supabase.from('equipments').update({ status: 'stocked', current_location: 'Warsaw Office', merchant_id: null }).eq('id', rma.equipment_id);
                await supabase.from('equipment_logs').insert([{
                    equipment_id: rma.equipment_id, merchant_id: rma.merchant_id,
                    action: 'RETURN_DELETED', from_location: 'In Transit / RMA', to_location: 'Warsaw Office',
                    notes: `Return ${rma.return_id} deleted. Unit reset to stock.`
                }]);
            } else if (rma.is_bulk) {
                const { data: items } = await supabase.from('return_items').select('equipment_id').eq('return_id', rma.id);
                for (const item of (items || [])) {
                    await supabase.from('equipments').update({ status: 'stocked', current_location: 'Warsaw Office', merchant_id: null }).eq('id', item.equipment_id);
                    await supabase.from('equipment_logs').insert([{
                        equipment_id: item.equipment_id, merchant_id: rma.merchant_id,
                        action: 'RETURN_DELETED', from_location: 'In Transit / RMA', to_location: 'Warsaw Office',
                        notes: `Bulk return ${rma.return_id} deleted. Unit reset to stock.`
                    }]);
                }
            }

            // Delete return_items then the return
            await supabase.from('return_items').delete().eq('return_id', rma.id);
            const { error: delErr } = await supabase.from('returns').delete().eq('id', rma.id);
            if (delErr) throw delErr;

            const { data: delActorRow } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
            const delActorEmail = delActorRow?.email || session.userid;
            const delActorName = delActorRow ? `${delActorRow.first_name || ''} ${delActorRow.last_name || ''}`.trim() || delActorRow.email : 'Staff';
            supabase.from('activity_logs').insert({
                email: delActorEmail,
                action: `RMA Deleted by ${delActorName} — ${rma.return_id}${rma.is_bulk ? ' (bulk)' : ''}`,
                status: 'success', category: 'returns', target_id: rma.id, target_type: 'return', severity: 'warning',
                old_value: { return_id: rma.return_id, equipment_id: rma.equipment_id, merchant_id: rma.merchant_id, is_bulk: rma.is_bulk }
            }).then(() => {}).catch(() => {});

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: "Invalid action" });
    } catch (err) {
        return res.status(500).json({ success: false, message: "Server Error: " + err.message });
    }
}
