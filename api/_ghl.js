import { getConfigValue } from './api-config.js';

// GHL (HighLevel) v2 API helpers. Auth = location API key (Bearer) + Version header,
// matching the existing ghl-documents.js integration.
const GHL_BASE = 'https://services.leadconnectorhq.com';

async function ghlKeys() {
    const key = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
    return key || null;
}

function ghlHeaders(key) {
    return { 'Authorization': `Bearer ${key}`, 'Version': '2021-07-28', 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

// Fetch a contact's address block by contact id. Returns null if unavailable.
export async function ghlGetContactAddress(contactId) {
    const key = await ghlKeys();
    if (!key || !contactId) return null;
    try {
        const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders(key) });
        if (!r.ok) return null;
        const data = await r.json().catch(() => ({}));
        const c = data?.contact || data || {};
        return {
            address: c.address1 || '',
            city: c.city || '',
            state: c.state || '',
            zip: c.postalCode || '',
            country: c.country || ''
        };
    } catch { return null; }
}

// Push an address block to a contact (best-effort). Only sends non-empty fields.
export async function ghlUpdateContactAddress(contactId, addr) {
    const key = await ghlKeys();
    if (!key || !contactId || !addr) return false;
    const body = {};
    if (addr.address) body.address1 = addr.address;
    if (addr.city) body.city = addr.city;
    if (addr.state) body.state = addr.state;
    if (addr.zip) body.postalCode = addr.zip;
    if (addr.country) body.country = addr.country;
    if (!Object.keys(body).length) return false;
    try {
        const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
            method: 'PUT', headers: ghlHeaders(key), body: JSON.stringify(body)
        });
        return r.ok;
    } catch { return false; }
}
