import { createClient } from '@supabase/supabase-js';
import { ssFetchResource } from './shipstation.js';

// ShipStation webhook receiver.
// Configure in ShipStation → Settings → Integrations → Webhooks with target:
//   https://<host>/api/shipstation-webhook?secret=<SHIPSTATION_WEBHOOK_SECRET>
// On SHIP_NOTIFY, ShipStation sends { resource_url, resource_type }; we fetch the
// shipments and write tracking back to our shipstation_shipments + deployments rows.
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    // Shared-secret check (query param or header)
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

        // Acknowledge non-ship events quickly
        if (resourceType !== 'SHIP_NOTIFY' && resourceType !== 'ITEM_SHIP_NOTIFY') {
            return res.status(200).json({ success: true, ignored: resourceType || 'unknown' });
        }
        if (!resourceUrl) return res.status(200).json({ success: true, ignored: 'no resource_url' });

        const data = await ssFetchResource(resourceUrl);
        const shipments = (data && Array.isArray(data.shipments)) ? data.shipments : [];

        let updated = 0;
        for (const sh of shipments) {
            const orderNumber = sh.orderNumber;
            const tracking = sh.trackingNumber;
            if (!orderNumber) continue;

            // Match our shipment by order_number
            const { data: rows } = await supabase.from('shipstation_shipments')
                .select('id, deployment_id, return_id')
                .eq('order_number', orderNumber);
            if (!rows || !rows.length) continue;

            for (const row of rows) {
                await supabase.from('shipstation_shipments').update({
                    tracking_number: tracking || null,
                    carrier: sh.carrierCode || null,
                    service: sh.serviceCode || null,
                    ss_shipment_id: sh.shipmentId ? String(sh.shipmentId) : null,
                    ss_order_id: sh.orderId ? String(sh.orderId) : null,
                    status: 'shipped'
                }).eq('id', row.id);

                // Write tracking back into the deployment (existing tracking_id column)
                if (row.deployment_id && tracking) {
                    await supabase.from('deployments').update({ tracking_id: tracking }).eq('id', row.deployment_id);
                }
                updated++;
            }
        }

        return res.status(200).json({ success: true, processed: shipments.length, updated });
    } catch (err) {
        console.error('[shipstation-webhook]', err.message);
        // Return 200 so ShipStation doesn't hammer retries on our internal errors
        return res.status(200).json({ success: false, message: 'handled with error' });
    }
}
