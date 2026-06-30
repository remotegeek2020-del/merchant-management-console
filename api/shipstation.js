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

// ── ShipStation V2 (api.shipstation.com/v2) — used for tracking-status lookups ─
const SS_V2_BASE = 'https://api.shipstation.com/v2';
async function getV2Key() {
    return (await getConfigValue('SHIPSTATION_V2_API_KEY')) || process.env.SHIPSTATION_V2_API_KEY || null;
}
function mapV2Carrier(c) {
    if (!c) return null;
    const s = String(c).toLowerCase();
    if (s.includes('stamp') || s.includes('usps')) return 'stamps_com';
    if (s.includes('fedex')) return 'fedex';
    if (s.includes('ups')) return 'ups';
    if (s.includes('dhl')) return 'dhl_express';
    return s;
}
function detectCarrierFromTracking(t) {
    const s = String(t || '').toUpperCase().replace(/\s/g, '');
    if (/^1Z[0-9A-Z]{16}$/.test(s)) return 'ups';
    if (/^[A-Z]{2}\d{9}US$/.test(s)) return 'stamps_com';           // USPS intl-style
    if (/^(94|93|92|95)\d{18,20}$/.test(s)) return 'stamps_com';    // USPS 20-22 digit
    if (/^\d{12}$/.test(s) || /^\d{15}$/.test(s)) return 'fedex';   // FedEx
    return null;
}
async function ssV2Tracking(carrierCode, tracking) {
    const key = await getV2Key();
    if (!key || !carrierCode || !tracking) return null;
    try {
        const r = await fetch(`${SS_V2_BASE}/tracking?carrier_code=${encodeURIComponent(carrierCode)}&tracking_number=${encodeURIComponent(tracking)}`, {
            headers: { 'API-Key': key }
        });
        const data = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, data };
    } catch { return null; }
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
    // ShipStation rejects malformed emails — omit anything that isn't valid
    const validEmail = e => (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e).trim())) ? String(e).trim() : undefined;
    const cleanEmail = validEmail(o.email);
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
        customerEmail: cleanEmail,
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

// Void a label by shipmentId (best-effort). Returns true if voided/approved.
export async function ssVoidLabelById(shipmentId) {
    const auth = await getAuthHeader();
    if (!auth || !shipmentId) return false;
    try {
        const r = await fetch(`${SS_BASE}/shipments/voidlabel`, {
            method: 'POST', headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ shipmentId: Number(shipmentId) })
        });
        const d = await r.json().catch(() => ({}));
        return r.ok && d.approved !== false;
    } catch { return false; }
}

// Delete (inactivate) a ShipStation order by orderId (best-effort).
export async function ssDeleteOrder(orderId) {
    const auth = await getAuthHeader();
    if (!auth || !orderId) return false;
    try {
        const r = await fetch(`${SS_BASE}/orders/${orderId}`, {
            method: 'DELETE', headers: { 'Authorization': auth, 'Content-Type': 'application/json' }
        });
        return r.ok;
    } catch { return false; }
}

// ── Generic ShipStation request helpers ─────────────────────────────────────
async function ssGet(path) {
    const auth = await getAuthHeader();
    if (!auth) return { ok: false, configured: false };
    const r = await fetch(`${SS_BASE}${path}`, { headers: { 'Authorization': auth, 'Content-Type': 'application/json' } });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data, configured: true };
}
async function ssPost(path, payload) {
    const auth = await getAuthHeader();
    if (!auth) return { ok: false, configured: false };
    const r = await fetch(`${SS_BASE}${path}`, {
        method: 'POST',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const raw = await r.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { _raw: raw }; }
    return { ok: r.ok, status: r.status, data, raw, configured: true };
}
const num = n => (n === null || n === undefined || n === '' ? undefined : Number(n));

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

        // ── RECONCILE DELIVERIES (V2): backtrack delivered tickets ───────────
        // For deployments with a tracking number that aren't Closed, look up the
        // live delivery status via ShipStation V2 tracking and, if delivered,
        // set the received date + close (merchant) / set partner date (partner).
        if (action === 'reconcile_deliveries') {
            const key = await getV2Key();
            if (!key) return res.status(200).json({ success: false, message: 'Add SHIPSTATION_V2_API_KEY in the API Key Manager first.' });
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            const limit = Math.min(Number(body.limit) || 50, 150);

            const { data: deps } = await supabase.from('deployments')
                .select('id, tracking_id, status, ship_to_type')
                .not('tracking_id', 'is', null).neq('tracking_id', '')
                .neq('status', 'Closed')
                .order('created_at', { ascending: false })
                .limit(limit);

            let checked = 0, closed = 0, partnerDated = 0, skipped = 0, notDelivered = 0, movedInTransit = 0;
            const skippedList = [];
            let sample = null;   // capture the first V2 response for diagnostics
            for (const d of (deps || [])) {
                // resolve carrier: prefer the stored SS carrier, else detect from tracking
                const { data: ssrow } = await supabase.from('shipstation_shipments')
                    .select('carrier').eq('deployment_id', d.id).not('carrier', 'is', null).limit(1).maybeSingle();
                const carrier = mapV2Carrier(ssrow?.carrier) || detectCarrierFromTracking(d.tracking_id);
                if (!carrier) { skipped++; if (skippedList.length < 25) skippedList.push({ tracking: d.tracking_id, reason: 'carrier unknown' }); continue; }

                const t = await ssV2Tracking(carrier, d.tracking_id);
                checked++;
                // V2 tracking is plan-gated — surface the billing error instead of a misleading count
                if (t?.status === 401 || t?.status === 403) {
                    const msg = t?.data?.errors?.[0]?.message || 'ShipStation V2 tracking endpoint is not available on this plan.';
                    return res.status(200).json({ success: false, plan_gated: true,
                        message: `ShipStation V2 tracking is blocked on your current plan (HTTP ${t.status}): "${msg}"` });
                }
                if (!sample) sample = {
                    carrier, tracking: d.tracking_id, http_status: t?.status, ok: !!t?.ok,
                    keys: t?.data ? Object.keys(t.data) : null,
                    status_code: t?.data?.status_code, status_description: t?.data?.status_description,
                    raw: JSON.stringify(t?.data || {}).slice(0, 600)
                };
                if (!t?.ok || !t.data) { notDelivered++; continue; }
                const sc = String(t.data.status_code || '').toUpperCase();
                const sd = String(t.data.status_description || '').toLowerCase();
                const delivered = sc === 'DE' || sd.includes('delivered');
                if (!delivered) {
                    // Not delivered — if it's moving, move an Open ticket to In Transit.
                    const inTransit = ['IT', 'AC', 'MV'].includes(sc) || /in[\s_-]?transit|out for delivery|accepted|picked up/.test(sd);
                    if (inTransit && (d.status || '') === 'Open') {
                        await supabase.from('deployments').update({ status: 'In Transit' }).eq('id', d.id).eq('status', 'Open');
                        movedInTransit++;
                    } else {
                        notDelivered++;
                    }
                    continue;
                }

                const delDate = (t.data.actual_delivery_date || t.data.estimated_delivery_date || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
                if ((d.ship_to_type || 'merchant') === 'partner') {
                    await supabase.from('deployments').update({ partner_received_date: delDate }).eq('id', d.id);
                    partnerDated++;
                } else {
                    await supabase.from('deployments').update({ merchant_received_date: delDate, status: 'Closed' }).eq('id', d.id);
                    closed++;
                }
            }
            return res.status(200).json({ success: true, scanned: (deps || []).length, checked, closed, partnerDated, movedInTransit, notDelivered, skipped, skippedList, sample });
        }

        // ── LINK BY TRACKING (old tickets): look a deployment's tracking # up in
        //     ShipStation and create the shipstation_shipments link so the edit
        //     ticket shows all the info. Falls back to carrier tracking if the
        //     number isn't a ShipStation label. ─────────────────────────────────
        if (action === 'link_by_tracking') {
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            const deploymentId = body.deployment_id;
            if (!deploymentId) return res.status(400).json({ success: false, message: 'deployment_id required' });

            const { data: dep } = await supabase.from('deployments')
                .select('id, merchant_id, tracking_id, ship_to_type, ship_to_partner_id, status')
                .eq('id', deploymentId).maybeSingle();
            if (!dep) return res.status(404).json({ success: false, message: 'Deployment not found' });
            const tid = (dep.tracking_id || '').trim();
            if (!tid) return res.status(200).json({ success: false, message: 'This ticket has no tracking number to look up.' });

            // Already linked?
            const { data: existing } = await supabase.from('shipstation_shipments')
                .select('id').eq('deployment_id', deploymentId).eq('ship_type', 'outbound').limit(1).maybeSingle();
            if (existing) return res.status(200).json({ success: true, already: true, message: 'Already linked to ShipStation.' });

            const norm = s => String(s || '').toUpperCase().replace(/\s/g, '');

            // 1) ShipStation V1 lookup by tracking number
            const auth = await getAuthHeader();
            let shipment = null;
            if (auth) {
                const r = await ssGet(`/shipments?trackingNumber=${encodeURIComponent(tid)}&includeShipmentItems=true`);
                if (r.ok && r.data) {
                    const list = Array.isArray(r.data.shipments) ? r.data.shipments : (Array.isArray(r.data) ? r.data : []);
                    // Filter to an exact tracking match (in case the API ignores the filter) — avoid mislinking
                    const matches = list.filter(s => norm(s.trackingNumber) === norm(tid));
                    shipment = matches.find(s => !s.voided) || matches[0] || null;
                }
            }

            if (shipment) {
                const st = shipment.shipTo || {};
                const insert = {
                    order_number:   shipment.orderNumber || null,
                    ss_order_id:    shipment.orderId != null ? String(shipment.orderId) : null,
                    ss_shipment_id: shipment.shipmentId != null ? String(shipment.shipmentId) : null,
                    ship_type:      'outbound',
                    merchant_id:    dep.merchant_id,
                    deployment_id:  deploymentId,
                    partner_id:     dep.ship_to_partner_id || null,
                    tracking_number: shipment.trackingNumber || tid,
                    carrier:        shipment.carrierCode || null,
                    service:        shipment.serviceCode || null,
                    ship_to_name:   st.name || null,
                    ship_to_company: st.company || null,
                    ship_to_phone:  st.phone || null,
                    address:        st.street1 || null,
                    address_line2:  st.street2 || null,
                    city:           st.city || null,
                    state:          st.state || null,
                    zip:            st.postalCode || null,
                    country:        st.country || 'US',
                    shipping_paid:  shipment.shipmentCost != null ? shipment.shipmentCost : null,
                    status:         shipment.voided ? 'voided' : 'shipped',
                    created_by:     session.userid
                };
                const { data: row, error } = await supabase.from('shipstation_shipments').insert(insert).select('*').single();
                if (error) throw error;
                if (shipment.trackingNumber && shipment.trackingNumber !== dep.tracking_id) {
                    await supabase.from('deployments').update({ tracking_id: shipment.trackingNumber }).eq('id', deploymentId);
                }
                return res.status(200).json({ success: true, source: 'shipstation', shipment: row });
            }

            // 2) Fallback: carrier tracking (V2) for carrier + delivery status
            const carrier = detectCarrierFromTracking(tid);
            let info = null;
            if (carrier) {
                const t = await ssV2Tracking(carrier, tid);
                if (t?.status === 401 || t?.status === 403) {
                    return res.status(200).json({ success: false, plan_gated: true,
                        message: 'Not found in ShipStation, and the carrier-tracking lookup is blocked on your current plan.' });
                }
                if (t?.ok && t.data) info = t.data;
            }

            if (info) {
                const sc = String(info.status_code || '').toUpperCase();
                const sd = String(info.status_description || '').toLowerCase();
                const delivered = sc === 'DE' || sd.includes('delivered');
                const delDate = (info.actual_delivery_date || info.estimated_delivery_date || '').slice(0, 10) || null;
                const insert = {
                    order_number: null, ss_order_id: null, ss_shipment_id: null,
                    ship_type: 'outbound', merchant_id: dep.merchant_id, deployment_id: deploymentId,
                    partner_id: dep.ship_to_partner_id || null,
                    tracking_number: tid, carrier, service: null,
                    status: delivered ? 'delivered' : (info.status_description || 'in_transit'),
                    store_name: 'Carrier lookup (not a ShipStation order)',
                    created_by: session.userid
                };
                const { data: row, error } = await supabase.from('shipstation_shipments').insert(insert).select('*').single();
                if (error) throw error;
                if (delivered && delDate) {
                    if ((dep.ship_to_type || 'merchant') === 'partner') {
                        await supabase.from('deployments').update({ partner_received_date: delDate }).eq('id', deploymentId);
                    } else {
                        await supabase.from('deployments').update({ merchant_received_date: delDate, status: 'Closed' }).eq('id', deploymentId);
                    }
                }
                return res.status(200).json({ success: true, source: 'carrier', shipment: row, delivered });
            }

            return res.status(200).json({ success: false,
                message: !auth ? 'ShipStation keys not configured.'
                    : (carrier ? 'Tracking number not found in ShipStation or carrier tracking.'
                               : 'Tracking number not found in ShipStation, and the carrier could not be detected for a fallback lookup.') });
        }

        // ── SHIP-FROM WAREHOUSES ────────────────────────────────────────────
        if (action === 'get_warehouses') {
            const r = await ssGet('/warehouses');
            if (!r.configured) return res.status(200).json({ success: true, configured: false, warehouses: [] });
            if (!r.ok) return res.status(200).json({ success: false, configured: true, message: `ShipStation ${r.status}` });
            const warehouses = (Array.isArray(r.data) ? r.data : []).map(w => ({
                id: String(w.warehouseId),
                name: w.warehouseName,
                postalCode: w.originAddress?.postalCode || w.returnAddress?.postalCode || null,
                isDefault: !!w.isDefault
            }));
            return res.status(200).json({ success: true, configured: true, warehouses });
        }

        // ── CARRIERS ────────────────────────────────────────────────────────
        if (action === 'get_carriers') {
            const r = await ssGet('/carriers');
            if (!r.configured) return res.status(200).json({ success: true, configured: false, carriers: [] });
            if (!r.ok) return res.status(200).json({ success: false, configured: true, message: `ShipStation ${r.status}` });
            const carriers = (Array.isArray(r.data) ? r.data : []).map(c => ({ code: c.code, name: c.name }));
            return res.status(200).json({ success: true, configured: true, carriers });
        }

        // ── SERVICES / PACKAGES for a carrier ───────────────────────────────
        if (action === 'list_services') {
            if (!body.carrier_code) return res.status(400).json({ success: false, message: 'carrier_code required' });
            const r = await ssGet(`/carriers/listservices?carrierCode=${encodeURIComponent(body.carrier_code)}`);
            if (!r.ok) return res.status(200).json({ success: false, configured: r.configured, services: [], message: r.data?.ExceptionMessage || r.data?.message || ('HTTP ' + r.status) });
            const services = (Array.isArray(r.data) ? r.data : []).map(s => ({ code: s.code, name: s.name }));
            return res.status(200).json({ success: true, configured: true, services });
        }
        if (action === 'list_packages') {
            if (!body.carrier_code) return res.status(400).json({ success: false, message: 'carrier_code required' });
            const r = await ssGet(`/carriers/listpackages?carrierCode=${encodeURIComponent(body.carrier_code)}`);
            if (!r.ok) return res.status(200).json({ success: false, configured: r.configured, packages: [], message: r.data?.ExceptionMessage || r.data?.message || ('HTTP ' + r.status) });
            const packages = (Array.isArray(r.data) ? r.data : []).map(p => ({ code: p.code, name: p.name }));
            return res.status(200).json({ success: true, configured: true, packages });
        }

        // ── GET RATES (one carrier, or loop all carriers like the Rate Browser) ─
        if (action === 'get_rates') {
            const auth = await getAuthHeader();
            if (!auth) return res.status(200).json({ success: true, configured: false, rates: [] });
            const base = {
                fromPostalCode: body.from_postal_code,
                toState: body.to_state,
                toCountry: countryCode(body.to_country),
                toPostalCode: body.to_postal_code,
                toCity: body.to_city || undefined,
                weight: body.weight,                    // { value, units }
                dimensions: body.dimensions || undefined,
                packageCode: body.package_code || 'package',
                confirmation: body.confirmation || 'none',
                residential: !!body.residential
            };
            // Guard: FedEx/UPS reject malformed US ZIPs
            if (base.toCountry === 'US' && !/^\d{5}(-\d{4})?$/.test(String(base.toPostalCode || ''))) {
                return res.status(200).json({ success: false, configured: true, rates: [], message: `Destination ZIP "${base.toPostalCode || ''}" is invalid (must be 5 digits). Fix the recipient address.` });
            }
            if (!base.fromPostalCode) {
                return res.status(200).json({ success: false, configured: true, rates: [], message: 'No "Ship From" ZIP — pick a warehouse with an origin ZIP in ShipStation.' });
            }
            if (!base.weight?.value) {
                return res.status(200).json({ success: false, configured: true, rates: [], message: 'Enter a package weight.' });
            }
            let carrierCodes = body.carrier_code ? [body.carrier_code] : null;
            if (!carrierCodes) {
                const cr = await ssGet('/carriers');
                carrierCodes = (Array.isArray(cr.data) ? cr.data : []).map(c => c.code);
            }
            const rates = [];
            const errors = [];
            for (const code of carrierCodes) {
                const r = await ssPost('/shipments/getrates', { ...base, carrierCode: code });
                if (r.ok && Array.isArray(r.data)) {
                    for (const rate of r.data) {
                        rates.push({
                            carrierCode: code,
                            serviceName: rate.serviceName,
                            serviceCode: rate.serviceCode,
                            shipmentCost: rate.shipmentCost,
                            otherCost: rate.otherCost,
                            totalCost: (Number(rate.shipmentCost) || 0) + (Number(rate.otherCost) || 0)
                        });
                    }
                } else if (!r.ok) {
                    errors.push(`${code}: ${r.data?.ExceptionMessage || r.data?.message || ('HTTP ' + r.status)}`);
                }
            }
            rates.sort((a, b) => a.totalCost - b.totalCost);
            return res.status(200).json({ success: true, configured: true, rates, errors: errors.length ? errors : undefined });
        }

        // ── CREATE LABEL for an existing order ──────────────────────────────
        if (action === 'create_label') {
            const auth = await getAuthHeader();
            if (!auth) return res.status(200).json({ success: false, configured: false, message: 'ShipStation keys not configured.' });
            const { ss_row_id, order_id, carrier_code, service_code, package_code,
                    confirmation, ship_date, weight, dimensions, insurance, test_label } = body;
            if (!order_id) return res.status(400).json({ success: false, message: 'order_id required' });

            const labelReq = {
                orderId: Number(order_id),
                carrierCode: carrier_code,
                serviceCode: service_code,
                packageCode: package_code || 'package',
                confirmation: confirmation || 'none',
                shipDate: ship_date || new Date().toISOString().slice(0, 10),
                weight: weight,                              // { value, units }
                dimensions: dimensions || undefined,
                insuranceOptions: insurance || undefined,
                testLabel: !!test_label
            };
            const r = await ssPost('/orders/createlabelfororder', labelReq);
            if (!r.ok) {
                const detail = r.data?.ExceptionMessage || r.data?.message || r.data?._raw || (r.raw || '').slice(0, 300) || '';
                return res.status(200).json({ success: false, configured: true, status: r.status, message: `ShipStation ${r.status}${detail ? ': ' + detail : ' — order not found. Try recreating the ticket so a fresh ShipStation order is generated.'}` });
            }
            const tracking = r.data.trackingNumber;
            const shipmentId = r.data.shipmentId;
            const cost = r.data.shipmentCost;

            // Test labels return a fake tracking # — don't persist them
            if (test_label) {
                return res.status(200).json({
                    success: true, configured: true, test: true,
                    trackingNumber: tracking, shipmentId, shipmentCost: cost,
                    labelData: r.data.labelData || null
                });
            }

            // Persist tracking + label back to our row and the deployment
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            if (ss_row_id) {
                const { data: row } = await supabase.from('shipstation_shipments')
                    .update({
                        tracking_number: tracking || null,
                        carrier: carrier_code || null,
                        service: service_code || null,
                        ss_shipment_id: shipmentId ? String(shipmentId) : null,
                        ss_label_url: r.data.labelData ? 'embedded' : null,
                        label_data: r.data.labelData || null,   // keep the PDF for no-charge reprints
                        status: 'shipped'
                    }).eq('id', ss_row_id).select('deployment_id, return_id, ss_order_id').single();
                if (row?.deployment_id && tracking) {
                    await supabase.from('deployments').update({ tracking_id: tracking, status: 'In Transit' }).eq('id', row.deployment_id).eq('status', 'Open');
                    await supabase.from('deployments').update({ tracking_id: tracking }).eq('id', row.deployment_id);
                }
                // Consolidated shipment: one label covers sibling tickets sharing the
                // same ShipStation order — propagate tracking + saved label to them all.
                if (row?.ss_order_id) {
                    const { data: siblings } = await supabase.from('shipstation_shipments')
                        .select('id, deployment_id').eq('ss_order_id', row.ss_order_id).neq('id', ss_row_id);
                    for (const sib of (siblings || [])) {
                        await supabase.from('shipstation_shipments').update({
                            tracking_number: tracking || null,
                            carrier: carrier_code || null, service: service_code || null,
                            ss_shipment_id: shipmentId ? String(shipmentId) : null,
                            label_data: r.data.labelData || null, ss_label_url: r.data.labelData ? 'embedded' : null,
                            status: 'shipped'
                        }).eq('id', sib.id);
                        if (sib.deployment_id && tracking) {
                            await supabase.from('deployments').update({ tracking_id: tracking }).eq('id', sib.deployment_id);
                            await supabase.from('deployments').update({ status: 'In Transit' }).eq('id', sib.deployment_id).eq('status', 'Open');
                        }
                    }
                }
            }
            return res.status(200).json({
                success: true, configured: true,
                trackingNumber: tracking, shipmentId, shipmentCost: cost,
                labelData: r.data.labelData || null   // base64 PDF
            });
        }

        // ── GET LABEL (no-charge reprint): return the saved base64 label PDF.
        //     Makes NO ShipStation call, so it never creates/charges a new label. ─
        if (action === 'get_label') {
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            const { ss_row_id, deployment_id } = body;
            let q = supabase.from('shipstation_shipments').select('id, label_data, tracking_number, carrier, service');
            if (ss_row_id) q = q.eq('id', ss_row_id);
            else if (deployment_id) q = q.eq('deployment_id', deployment_id).eq('ship_type', 'outbound').order('created_at', { ascending: false });
            else return res.status(400).json({ success: false, message: 'ss_row_id or deployment_id required' });
            const { data: row } = await q.limit(1).maybeSingle();
            if (!row) return res.status(200).json({ success: false, message: 'No shipment found.' });
            if (!row.label_data) {
                return res.status(200).json({ success: false, no_label: true,
                    message: 'This label was created before in-app reprint was available, so the PDF wasn’t saved. Reprint it from ShipStation, or Void & recreate here (recreating charges a new label).' });
            }
            return res.status(200).json({ success: true, labelData: row.label_data, tracking_number: row.tracking_number, carrier: row.carrier, service: row.service });
        }

        // ── REFRESH SHIPMENT: live-pull latest tracking/status for a deployment ─
        if (action === 'refresh_shipment') {
            const { deployment_id } = body;
            if (!deployment_id) return res.status(400).json({ success: false, message: 'deployment_id required' });
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            const { data: row } = await supabase.from('shipstation_shipments')
                .select('*').eq('deployment_id', deployment_id).eq('ship_type', 'outbound')
                .order('created_at', { ascending: false }).limit(1).maybeSingle();
            if (!row) return res.status(200).json({ success: true, shipment: null });

            // Enrich: merchant's agent ID (the partner ID tied to the merchant),
            // ship-to type, and partner name — for the edit-ticket info panel.
            try {
                const { data: dep } = await supabase.from('deployments')
                    .select('ship_to_type, merchant_id').eq('id', deployment_id).maybeSingle();
                if (dep) {
                    row.ship_to_type = dep.ship_to_type || 'merchant';
                    if (dep.merchant_id) {
                        const { data: mer } = await supabase.from('merchants').select('agent_id').eq('id', dep.merchant_id).maybeSingle();
                        row.merchant_agent_id = mer?.agent_id || null;
                    }
                }
                if (row.partner_id) {
                    const { data: per } = await supabase.from('persons').select('full_name').eq('id', row.partner_id).maybeSingle();
                    row.partner_name = per?.full_name || null;
                }
            } catch (e) { /* enrichment best-effort */ }

            const auth = await getAuthHeader();
            if (auth && (row.ss_order_id || row.order_number)) {
                const url = row.ss_order_id
                    ? `/shipments?orderId=${row.ss_order_id}`
                    : `/shipments?orderNumber=${encodeURIComponent(row.order_number)}`;
                const r = await ssGet(url);
                const sh = (r.ok && Array.isArray(r.data?.shipments)) ? r.data.shipments.find(s => !s.voided) : null;
                if (sh && sh.trackingNumber && sh.trackingNumber !== row.tracking_number) {
                    await supabase.from('shipstation_shipments').update({
                        tracking_number: sh.trackingNumber,
                        carrier: sh.carrierCode || row.carrier,
                        service: sh.serviceCode || row.service,
                        ss_shipment_id: sh.shipmentId ? String(sh.shipmentId) : row.ss_shipment_id,
                        status: 'shipped'
                    }).eq('id', row.id);
                    await supabase.from('deployments').update({ tracking_id: sh.trackingNumber }).eq('id', deployment_id);
                    row.tracking_number = sh.trackingNumber;
                    row.carrier = sh.carrierCode || row.carrier;
                    row.service = sh.serviceCode || row.service;
                    row.ss_shipment_id = sh.shipmentId ? String(sh.shipmentId) : row.ss_shipment_id;
                    row.status = 'shipped';
                }
            }
            return res.status(200).json({ success: true, shipment: row });
        }

        // ── VOID LABEL (refund) ─────────────────────────────────────────────
        if (action === 'void_label') {
            const auth = await getAuthHeader();
            if (!auth) return res.status(200).json({ success: false, configured: false, message: 'ShipStation keys not configured.' });
            const { ss_row_id, shipment_id } = body;
            if (!shipment_id) return res.status(400).json({ success: false, message: 'shipment_id required' });

            const r = await ssPost('/shipments/voidlabel', { shipmentId: Number(shipment_id) });
            if (!r.ok) {
                const detail = r.data?.ExceptionMessage || r.data?.message || r.data?._raw || (r.raw || '').slice(0, 300);
                return res.status(200).json({ success: false, configured: true, message: `ShipStation ${r.status}${detail ? ': ' + detail : ''}` });
            }
            // ShipStation returns { approved: bool, message }
            if (r.data && r.data.approved === false) {
                return res.status(200).json({ success: false, configured: true, message: r.data.message || 'Void was not approved by the carrier.' });
            }

            // Clear tracking from our row + the deployment
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            if (ss_row_id) {
                const { data: row } = await supabase.from('shipstation_shipments')
                    .update({ status: 'voided', tracking_number: null }).eq('id', ss_row_id)
                    .select('deployment_id').single();
                if (row?.deployment_id) {
                    await supabase.from('deployments').update({ tracking_id: null }).eq('id', row.deployment_id);
                }
            }
            return res.status(200).json({ success: true, configured: true, approved: r.data?.approved !== false, message: r.data?.message || 'Label voided.' });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[shipstation]', err.message);
        return res.status(500).json({ success: false, message: 'ShipStation request failed.' });
    }
}
