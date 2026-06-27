import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { getConfigValue } from './api-config.js';

const SS_BASE = 'https://ssapi.shipstation.com';

// Build the HTTP Basic auth header. Prefer Vercel env vars; fall back to
// encrypted app_config so either storage method works.
async function getShipStationKeys() {
    let key = process.env.SHIPSTATION_API_KEY;
    let secret = process.env.SHIPSTATION_API_SECRET;
    if (!key || !secret) {
        key = key || await getConfigValue('SHIPSTATION_API_KEY');
        secret = secret || await getConfigValue('SHIPSTATION_API_SECRET');
    }
    return { key, secret };
}

async function getAuthHeader() {
    const { key, secret } = await getShipStationKeys();
    if (!key || !secret) return null;
    return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

export async function shipStationConfigured() {
    return !!(await getAuthHeader());
}

// ShipStation needs a 2-char country code; map the common full name.
function countryCode(c) {
    if (!c) return 'US';
    const t = String(c).trim();
    if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
    if (/united states/i.test(t)) return 'US';
    if (/canada/i.test(t)) return 'CA';
    return 'US';
}

// Create a ShipStation order (V1 POST /orders/createorder).
// `o` is a normalized object built from a shipstation_shipments row.
export async function ssCreateOrder(o) {
    const auth = await getAuthHeader();
    if (!auth) return { success: false, configured: false };

    const num = n => (n === null || n === undefined || n === '' ? undefined : Number(n));
    const orderPayload = {
        orderNumber: o.orderNumber,
        orderDate: o.orderDate || new Date().toISOString().slice(0, 10),
        paymentDate: o.paymentDate || undefined,
        orderStatus: 'awaiting_shipment',
        billTo: { name: o.shipTo?.name || 'Customer' },
        shipTo: {
            name: o.shipTo?.name || 'Customer',
            company: o.shipTo?.company || undefined,
            street1: o.shipTo?.street1 || '',
            street2: o.shipTo?.street2 || undefined,
            city: o.shipTo?.city || '',
            state: o.shipTo?.state || '',
            postalCode: o.shipTo?.postalCode || '',
            country: countryCode(o.shipTo?.country),
            phone: o.shipTo?.phone || undefined
        },
        customerEmail: o.email || undefined,
        items: (o.items && o.items.length) ? o.items.map(it => ({
            sku: it.sku || undefined,
            name: it.name || 'Equipment',
            quantity: it.quantity || 1
        })) : undefined,
        amountPaid: num(o.amountPaid),
        taxAmount: num(o.taxAmount),
        shippingAmount: num(o.shippingAmount),
        advancedOptions: o.storeId ? { storeId: Number(o.storeId) } : undefined
    };

    try {
        const ssRes = await fetch(`${SS_BASE}/orders/createorder`, {
            method: 'POST',
            headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
            body: JSON.stringify(orderPayload)
        });
        const data = await ssRes.json().catch(() => ({}));
        if (!ssRes.ok) {
            return { success: false, configured: true, status: ssRes.status, message: data?.ExceptionMessage || data?.message || JSON.stringify(data).slice(0, 300) };
        }
        return { success: true, orderId: data.orderId, orderNumber: data.orderNumber, orderKey: data.orderKey };
    } catch (e) {
        return { success: false, configured: true, message: e.message };
    }
}

// Fetch shipments from a webhook resource_url (already absolute).
export async function ssFetchResource(resourceUrl) {
    const auth = await getAuthHeader();
    if (!auth) return null;
    const r = await fetch(resourceUrl, { headers: { 'Authorization': auth, 'Content-Type': 'application/json' } });
    if (!r.ok) return null;
    return r.json();
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');
    const body = req.body || {};
    const action = body.action;

    try {
        // ── GET STORES (live ShipStation sales channels) ────────────────────
        if (action === 'get_stores') {
            const auth = await getAuthHeader();
            if (!auth) {
                // Keys not configured yet — return empty + flag so the UI can explain
                return res.status(200).json({ success: true, configured: false, stores: [] });
            }
            const params = body.show_inactive ? '?showInactive=true' : '';
            const ssRes = await fetch(`${SS_BASE}/stores${params}`, {
                headers: { 'Authorization': auth, 'Content-Type': 'application/json' }
            });
            if (!ssRes.ok) {
                const txt = await ssRes.text().catch(() => '');
                return res.status(200).json({ success: false, configured: true, message: `ShipStation ${ssRes.status}: ${txt.slice(0, 200)}` });
            }
            const data = await ssRes.json();
            const stores = (Array.isArray(data) ? data : []).map(s => ({
                id: String(s.storeId),
                name: s.storeName,
                active: s.active !== false
            }));
            return res.status(200).json({ success: true, configured: true, stores });
        }

        // ── RECONCILE (backtrack): pull recent ShipStation shipments and match
        //     by orderNumber → our shipstation_shipments, writing tracking back ──
        if (action === 'reconcile') {
            const auth = await getAuthHeader();
            if (!auth) return res.status(200).json({ success: false, configured: false, message: 'ShipStation keys not configured.' });

            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            const pageSize = Math.min(Number(body.page_size) || 100, 500);
            const ssRes = await fetch(`${SS_BASE}/shipments?pageSize=${pageSize}&sortBy=ShipDate&sortDir=DESC`, {
                headers: { 'Authorization': auth, 'Content-Type': 'application/json' }
            });
            if (!ssRes.ok) {
                const txt = await ssRes.text().catch(() => '');
                return res.status(200).json({ success: false, configured: true, message: `ShipStation ${ssRes.status}: ${txt.slice(0, 200)}` });
            }
            const data = await ssRes.json();
            const shipments = Array.isArray(data?.shipments) ? data.shipments : [];
            let matched = 0;
            for (const sh of shipments) {
                if (!sh.orderNumber) continue;
                const { data: rows } = await supabase.from('shipstation_shipments')
                    .select('id, deployment_id').eq('order_number', sh.orderNumber);
                for (const row of (rows || [])) {
                    await supabase.from('shipstation_shipments').update({
                        tracking_number: sh.trackingNumber || null,
                        carrier: sh.carrierCode || null,
                        service: sh.serviceCode || null,
                        ss_shipment_id: sh.shipmentId ? String(sh.shipmentId) : null,
                        ss_order_id: sh.orderId ? String(sh.orderId) : null,
                        status: sh.voided ? 'voided' : 'shipped'
                    }).eq('id', row.id);
                    if (row.deployment_id && sh.trackingNumber) {
                        await supabase.from('deployments').update({ tracking_id: sh.trackingNumber }).eq('id', row.deployment_id);
                    }
                    matched++;
                }
            }
            return res.status(200).json({ success: true, configured: true, scanned: shipments.length, matched });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[shipstation]', err.message);
        return res.status(500).json({ success: false, message: 'ShipStation request failed.' });
    }
}
