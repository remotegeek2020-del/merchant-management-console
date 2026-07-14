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

// Resolve a set of GHL location ids → { id: name } (best-effort, agency token).
export async function ghlLocationNames(ids) {
    const token = (await getConfigValue('GHL_AGENCY_TOKEN')) || process.env.GHL_AGENCY_TOKEN;
    const out = {};
    if (!token || !Array.isArray(ids) || !ids.length) return out;
    const uniq = [...new Set(ids.filter(Boolean))].slice(0, 50);
    await Promise.all(uniq.map(async (id) => {
        try {
            const r = await fetch(`${GHL_BASE}/locations/${encodeURIComponent(id)}`, { headers: ghlHeaders(token) });
            if (!r.ok) return;
            const data = await r.json().catch(() => ({}));
            const l = data?.location || data || {};
            out[id] = l.name || l.businessName || id;
        } catch { /* ignore */ }
    }));
    return out;
}

// ── Agency-level: list all sub-accounts (locations) ──────────────────────────
// Uses an agency Private Integration token (GHL_AGENCY_TOKEN) + company id
// (GHL_COMPANY_ID). Returns { configured, locations:[{id,name}] }.
export async function ghlListLocations() {
    const token = (await getConfigValue('GHL_AGENCY_TOKEN')) || process.env.GHL_AGENCY_TOKEN;
    const companyId = (await getConfigValue('GHL_COMPANY_ID')) || process.env.GHL_COMPANY_ID;
    if (!token || !companyId) return { configured: false, locations: [] };
    const out = [];
    try {
        const limit = 100;
        for (let skip = 0; skip < 5000; skip += limit) {
            const url = `${GHL_BASE}/locations/search?companyId=${encodeURIComponent(companyId)}&limit=${limit}&skip=${skip}`;
            const r = await fetch(url, { headers: ghlHeaders(token) });
            if (!r.ok) break;
            const data = await r.json().catch(() => ({}));
            const locs = data?.locations || [];
            locs.forEach(l => { if (l && l.id) out.push({ id: String(l.id), name: l.name || l.businessName || l.id }); });
            if (locs.length < limit) break;
        }
        return { configured: true, locations: out };
    } catch {
        return { configured: true, locations: out, error: true };
    }
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
