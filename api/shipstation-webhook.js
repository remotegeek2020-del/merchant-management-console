import { createClient } from '@supabase/supabase-js';
import { ssFetchResource } from './shipstation.js';

// ShipStation webhook receiver. Register TWO webhooks pointing here:
//   1. "On Orders Shipped"   → writes tracking number to the deployment
//   2. "On New Track Event"  → on Delivered, sets received date + closes the ticket
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

        let trackingWrites = 0, deliveries = 0;
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
                    trackingWrites++;
                }
            }

            // (2) Delivered → set received date + close (always-on, matches by tracking too)
            if (isDelivered(it)) {
                deliveries += await applyDelivery(supabase, {
                    tracking, orderNumber, delDate: deliveryDateOf(it)
                });
            }
        }

        return res.status(200).json({ success: true, event: resourceType, processed: items.length, trackingWrites, deliveries });
    } catch (err) {
        console.error('[shipstation-webhook]', err.message);
        return res.status(200).json({ success: false, message: 'handled with error' });
    }
}
