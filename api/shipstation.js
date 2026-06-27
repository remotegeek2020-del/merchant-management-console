import { validateSession, sessionErrorResponse } from './_validate.js';
import { getConfigValue } from './api-config.js';

const SS_BASE = 'https://ssapi.shipstation.com';

// Build the HTTP Basic auth header from keys stored (encrypted) in app_config.
async function getAuthHeader() {
    const key = await getConfigValue('SHIPSTATION_API_KEY');
    const secret = await getConfigValue('SHIPSTATION_API_SECRET');
    if (!key || !secret) return null;
    return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
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

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[shipstation]', err.message);
        return res.status(500).json({ success: false, message: 'ShipStation request failed.' });
    }
}
