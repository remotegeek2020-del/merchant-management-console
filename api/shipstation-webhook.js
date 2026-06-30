import { createClient } from '@supabase/supabase-js';
import { ssFetchResource } from './shipstation.js';

// ShipStation webhook receiver. Register TWO webhooks pointing here:
//   1. "On Orders Shipped"   → writes tracking number to the deployment
//   2. "On New Track Event"  → on Delivered: deployments get received date + Closed;
//                              return labels get restocked to HQ + the RMA is completed
// URL: https://<host>/api/shipstation-webhook?secret=<SHIPSTATION_WEBHOOK_SECRET>

function isDelivered(obj) {
    if (!obj) return false;
    const s = String(obj.statusCode || obj.status || obj.deliveryStatus || obj.trackingStatus || '').toLowerCase();
    return s === 'delivered' || s === 'de' || obj.delivered === true ||
           !!obj.deliveryDate || !!obj.actualDeliveryDate;
}
function deliveryDateOf(obj) {
    const d = obj.deliveryDate || obj.actualDeliveryDate || obj.occurredAt || obj.eventDate || null;
    return d ? String(d).slice(0, 10) : new Date().toISOString().slice(0, 10);
}
// In-transit (moving, not yet delivered): ShipStation status codes IT/AC/MV or
// descriptions like "in transit", "accepted", "out for delivery", "picked up".
function isInTransit(obj) {
    if (!obj) return false;
    if (isDelivered(obj)) return false;
    const code = String(obj.statusCode || obj.status_code || '').toUpperCase();
    if (['IT', 'AC', 'MV'].includes(code)) return true;
    const s = String(obj.statusCode || obj.status || obj.deliveryStatus || obj.trackingStatus || obj.status_description || '').toLowerCase();
    return /in[\s_-]?transit|out for delivery|accepted|picked up|in_?transit/.test(s);
}

// Move matching deployments to 'In Transit' (only from 'Open' — never downgrade
// a Closed ticket or override a manual In Transit). Matches by tracking + order #.
async function applyInTransit(supabase, { tracking, orderNumber }) {
    const ids = new Set();
    if (tracking) {
        const { data } = await supabase.from('deployments').select('id').eq('tracking_id', tracking).eq('status', 'Open');
        for (const d of (data || [])) ids.add(d.id);
    }
    if (orderNumber) {
        await supabase.from('shipstation_shipments').update({ status: 'in_transit' }).eq('order_number', orderNumber).neq('status', 'delivered');
        const { data: rows } = await supabase.from('shipstation_shipments').select('deployment_id').eq('order_number', orderNumber);
        const depIds = (rows || []).map(r => r.deployment_id).filter(Boolean);
        if (depIds.length) {
            const { data: deps } = await supabase.from('deployments').select('id').in('id', depIds).eq('status', 'Open');
            for (const d of (deps || [])) ids.add(d.id);
        }
    }
    let moved = 0;
    for (const id of ids) {
        await supabase.from('deployments').update({ status: 'In Transit' }).eq('id', id).eq('status', 'Open');
        moved++;
    }
    return moved;
}

// Mark a deployment delivered: merchant-direct → received date + Closed;
// partner-first → partner_received_date only (merchant leg handled manually).
async function applyDelivery(supabase, { tracking, orderNumber, delDate }) {
    const targets = new Map(); // id → ship_to_type

    if (tracking) {
        const { data } = await supabase.from('deployments').select('id, ship_to_type').eq('tracking_id', tracking);
        for (const d of (data || [])) targets.set(d.id, d.ship_to_type || 'merchant');
    }
    if (orderNumber) {
        await supabase.from('shipstation_shipments').update({ status: 'delivered' }).eq('order_number', orderNumber);
        const { data: rows } = await supabase.from('shipstation_shipments').select('deployment_id').eq('order_number', orderNumber);
        const ids = (rows || []).map(r => r.deployment_id).filter(Boolean);
        if (ids.length) {
            const { data: deps } = await supabase.from('deployments').select('id, ship_to_type').in('id', ids);
            for (const d of (deps || [])) targets.set(d.id, d.ship_to_type || 'merchant');
        }
    }

    let closed = 0;
    for (const [id, shipType] of targets) {
        if (shipType === 'partner') {
            await supabase.from('deployments').update({ partner_received_date: delDate }).eq('id', id);
        } else {
            await supabase.from('deployments').update({ merchant_received_date: delDate, status: 'Closed' }).eq('id', id);
        }
        closed++;
    }
    return closed;
}

// When a RETURN LABEL is delivered (unit received back at PayProTec HQ), mirror the
// manual "Complete RMA → Warsaw Office" flow: restock the equipment, set received
// date, and close the RMA (+ linked deployment when fully returned). Idempotent —
// already-Closed returns are skipped.
async function completeReturnOnDelivery(supabase, { tracking, orderNumber, delDate }) {
    const retIds = new Set();
    const collect = async (col, val) => {
        if (!val) return;
        const { data } = await supabase.from('shipstation_shipments')
            .select('id, return_id, ship_type').eq(col, val);
        for (const r of (data || [])) {
            if (r.ship_type === 'return_label' && r.return_id) retIds.add(r.return_id);
            await supabase.from('shipstation_shipments').update({ status: 'delivered' }).eq('id', r.id);
        }
    };
    await collect('order_number', orderNumber);
    await collect('tracking_number', tracking);
    if (!retIds.size) return 0;

    const condition = 'Working (Back to Stock)';
    const destination = 'Warsaw Office';
    const finalStatus = 'stocked', finalLocation = 'Warsaw Office';
    let completed = 0;

    for (const rid of retIds) {
        try {
            const { data: rma } = await supabase.from('returns')
                .select('id, return_id, deployment_id, merchant_id, ticket_id, is_bulk, equipment_id, status')
                .eq('id', rid).maybeSingle();
            if (!rma) continue;
            if (String(rma.status || '').toLowerCase() === 'closed') continue; // already completed

            // Restock equipment back to HQ
            if (rma.is_bulk) {
                const { data: retItems } = await supabase.from('return_items').select('equipment_id').eq('return_id', rid);
                for (const ri of (retItems || [])) {
                    await supabase.from('equipments')
                        .update({ status: finalStatus, current_location: finalLocation, merchant_id: null })
                        .eq('id', ri.equipment_id);
                }
                await supabase.from('return_items').update({ condition }).eq('return_id', rid);
                if ((retItems || []).length) {
                    await supabase.from('equipment_logs').insert((retItems || []).map(ri => ({
                        equipment_id: ri.equipment_id, merchant_id: rma.merchant_id,
                        action: 'RMA Completed', from_location: 'In Transit / RMA', to_location: finalLocation,
                        notes: 'Auto-completed on ShipStation delivery to HQ. Unit restocked.'
                    })));
                }
            } else if (rma.equipment_id) {
                await supabase.from('equipments')
                    .update({ status: finalStatus, current_location: finalLocation, merchant_id: null })
                    .eq('id', rma.equipment_id);
                await supabase.from('equipment_logs').insert([{
                    equipment_id: rma.equipment_id, merchant_id: rma.merchant_id,
                    action: 'RMA Completed', from_location: 'In Transit / RMA', to_location: finalLocation,
                    notes: 'Auto-completed on ShipStation delivery to HQ. Unit restocked.'
                }]);
            }

            // Close the linked deployment — for bulk, only when ALL units are returned
            if (rma.deployment_id) {
                let shouldClose = true;
                if (rma.is_bulk) {
                    const { count: totalItems } = await supabase.from('deployment_items')
                        .select('id', { count: 'exact', head: true }).eq('deployment_id', rma.deployment_id);
                    const { data: closedRets } = await supabase.from('returns')
                        .select('id').eq('deployment_id', rma.deployment_id).eq('status', 'Closed');
                    let returnedCount = 0;
                    for (const cr of (closedRets || [])) {
                        const { count } = await supabase.from('return_items')
                            .select('id', { count: 'exact', head: true }).eq('return_id', cr.id);
                        returnedCount += count || 0;
                    }
                    const { count: currentItems } = await supabase.from('return_items')
                        .select('id', { count: 'exact', head: true }).eq('return_id', rid);
                    returnedCount += currentItems || 0;
                    shouldClose = totalItems > 0 && returnedCount >= totalItems;
                }
                if (shouldClose) await supabase.from('deployments').update({ status: 'Closed' }).eq('id', rma.deployment_id);
            }

            // Close the RMA + stamp received date
            await supabase.from('returns').update({
                condition, destination, status: 'Closed',
                equipment_received_date: delDate, updated_at: new Date().toISOString()
            }).eq('id', rid);

            // Auto-close linked support ticket
            if (rma.ticket_id) {
                await supabase.from('support_tickets')
                    .update({ status: 'closed', updated_at: new Date().toISOString() }).eq('id', rma.ticket_id);
            }

            await supabase.from('activity_logs').insert({
                email: 'shipstation-webhook',
                action: `RMA auto-completed on delivery to HQ — ${rma.return_id || rid} → ${destination}`,
                status: 'success', category: 'returns',
                target_id: rma.return_id || rid, target_type: 'return', severity: 'info',
                new_value: { status: 'Closed', condition, destination, equipment_status: finalStatus, equipment_location: finalLocation, equipment_received_date: delDate, source: 'shipstation_delivery' }
            }).then(() => {}).catch(() => {});
            completed++;
        } catch (e) { console.warn('[completeReturnOnDelivery]', e.message); }
    }
    return completed;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const expected = process.env.SHIPSTATION_WEBHOOK_SECRET;
    const provided = req.query?.secret || req.headers['x-webhook-secret'];
    if (expected && provided !== expected) {
        return res.status(401).json({ success: false, message: 'Invalid webhook secret.' });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        const body = req.body || {};
        const resourceType = body.resource_type;
        const resourceUrl = body.resource_url;
        console.log('[shipstation-webhook] event:', resourceType);
        if (!resourceUrl) return res.status(200).json({ success: true, ignored: 'no resource_url' });

        const data = await ssFetchResource(resourceUrl);

        // Normalize to a list of items (shipments or track events)
        let items = [];
        if (Array.isArray(data)) items = data;
        else if (data && Array.isArray(data.shipments)) items = data.shipments;
        else if (data) items = [data];

        let trackingWrites = 0, deliveries = 0, returnsCompleted = 0, inTransit = 0;
        for (const it of items) {
            const tracking = it.trackingNumber || it.tracking_number;
            const orderNumber = it.orderNumber;

            // (1) Ship event → write tracking back to the deployment
            if ((resourceType === 'SHIP_NOTIFY' || resourceType === 'ITEM_SHIP_NOTIFY') && orderNumber) {
                const { data: rows } = await supabase.from('shipstation_shipments')
                    .select('id, deployment_id').eq('order_number', orderNumber);
                for (const row of (rows || [])) {
                    await supabase.from('shipstation_shipments').update({
                        tracking_number: tracking || null,
                        carrier: it.carrierCode || null,
                        service: it.serviceCode || null,
                        ss_shipment_id: it.shipmentId ? String(it.shipmentId) : null,
                        ss_order_id: it.orderId ? String(it.orderId) : null,
                        status: 'shipped'
                    }).eq('id', row.id);
                    if (row.deployment_id && tracking) {
                        await supabase.from('deployments').update({ tracking_id: tracking }).eq('id', row.deployment_id);
                    }
                    // A shipped label means the unit is now in transit — move Open → In Transit.
                    if (row.deployment_id) {
                        await supabase.from('deployments').update({ status: 'In Transit' })
                            .eq('id', row.deployment_id).eq('status', 'Open');
                    }
                    trackingWrites++;
                }
            }

            // (2) Delivered → deployments: received date + close;
            //     return labels: restock to HQ + complete the RMA (always-on, matches by tracking too)
            if (isDelivered(it)) {
                const delDate = deliveryDateOf(it);
                deliveries += await applyDelivery(supabase, { tracking, orderNumber, delDate });
                returnsCompleted += await completeReturnOnDelivery(supabase, { tracking, orderNumber, delDate });
            } else if (isInTransit(it)) {
                inTransit += await applyInTransit(supabase, { tracking, orderNumber });
            }
        }

        return res.status(200).json({ success: true, event: resourceType, processed: items.length, trackingWrites, deliveries, returnsCompleted, inTransit });
    } catch (err) {
        console.error('[shipstation-webhook]', err.message);
        return res.status(200).json({ success: false, message: 'handled with error' });
    }
}
