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

// ── Location access token (agency token → sub-account token) ─────────────────
// Reading a sub-account's contacts/forms/appointments needs a LOCATION token,
// which we mint from the agency Private Integration token + companyId.
const _locTokens = {};   // simple per-process cache
async function mintLocationToken(locationId) {
    if (_locTokens[locationId] && _locTokens[locationId].exp > Date.now()) return _locTokens[locationId].t;
    const token = (await getConfigValue('GHL_AGENCY_TOKEN')) || process.env.GHL_AGENCY_TOKEN;
    const companyId = (await getConfigValue('GHL_COMPANY_ID')) || process.env.GHL_COMPANY_ID;
    if (!token || !companyId) return null;
    try {
        const r = await fetch(`${GHL_BASE}/oauth/locationToken`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ companyId, locationId }).toString()
        });
        if (!r.ok) return null;
        const d = await r.json().catch(() => ({}));
        if (!d.access_token) return null;
        _locTokens[locationId] = { t: d.access_token, exp: Date.now() + 20 * 60 * 1000 };
        return d.access_token;
    } catch { return null; }
}

export async function ghlLocationToken(locationId) {
    if (!locationId) return null;
    // 1) A token pasted for THIS specific sub-account (needed for extra sub-accounts).
    const stored = await getConfigValue('GHL_LOCTOKEN:' + locationId);
    if (stored) return stored;
    // 2) Mint a per-location token from the agency token (correct per location).
    const minted = await mintLocationToken(locationId);
    if (minted) return minted;
    // 3) Fall back to the sub-account Private Integration token already configured
    //    (Secret Dungeon → API Manager, GHL_API_KEY). Works for the sub-account it
    //    belongs to; add a per-sub-account token above for any others.
    return (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY || null;
}

async function locGet(locationId, path) {
    const lt = await ghlLocationToken(locationId);
    if (!lt) return null;
    try {
        const r = await fetch(`${GHL_BASE}${path}`, { headers: { 'Authorization': `Bearer ${lt}`, 'Version': '2021-07-28', 'Accept': 'application/json' } });
        if (!r.ok) return null;
        return await r.json().catch(() => null);
    } catch { return null; }
}

// Forms + calendars in a sub-account (for the campaign conversion pickers).
export async function ghlListForms(locationId) {
    const d = await locGet(locationId, `/forms/?locationId=${encodeURIComponent(locationId)}&limit=200`);
    return (d?.forms || []).map(f => ({ id: f.id, name: f.name || f.id }));
}
export async function ghlListCalendars(locationId) {
    const d = await locGet(locationId, `/calendars/?locationId=${encodeURIComponent(locationId)}`);
    return (d?.calendars || []).map(c => ({ id: c.id, name: c.name || c.id }));
}

// Tags in a sub-account (for the lead-capture tag picker).
export async function ghlListTags(locationId) {
    const d = await locGet(locationId, `/locations/${encodeURIComponent(locationId)}/tags`);
    return (d?.tags || []).map(t => ({ id: t.id, name: t.name || t.id }));
}

// Create/update a contact in a sub-account with optional tags (lead push).
export async function ghlUpsertContact(locationId, contact = {}, tags = []) {
    const lt = await ghlLocationToken(locationId);
    if (!lt) return { ok: false, error: 'no location token' };
    const parts = String(contact.name || '').trim().split(/\s+/).filter(Boolean);
    const body = {
        locationId,
        email: contact.email || undefined,
        phone: contact.phone || undefined,
        firstName: parts.shift() || undefined,
        lastName: parts.join(' ') || undefined,
        tags: (Array.isArray(tags) && tags.length) ? tags : undefined,
        source: 'PayProTec Announcement'
    };
    try {
        const r = await fetch(`${GHL_BASE}/contacts/upsert`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${lt}`, 'Version': '2021-07-28', 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
        });
        const j = await r.json().catch(() => null);
        return { ok: r.ok, id: j?.contact?.id || null, error: r.ok ? null : (j?.message || ('HTTP ' + r.status)) };
    } catch (e) { return { ok: false, error: e.message }; }
}

// Form submissions for a form within a date window → normalized conversions.
export async function ghlFormSubmissions(locationId, formId, startMs, endMs) {
    if (!formId) return [];
    const s = new Date(startMs).toISOString(), e = new Date(endMs).toISOString();
    const d = await locGet(locationId, `/forms/submissions?locationId=${encodeURIComponent(locationId)}&formId=${encodeURIComponent(formId)}&startAt=${encodeURIComponent(s)}&endAt=${encodeURIComponent(e)}&limit=100`);
    return (d?.submissions || []).map(x => ({
        type: 'form', name: x.name || `${x.firstName || ''} ${x.lastName || ''}`.trim() || 'Lead',
        email: x.email || '', phone: x.phone || '', contact_id: x.contactId || '', at: x.createdAt || x.dateAdded || null
    }));
}

// Appointments on a calendar within a window → normalized conversions.
export async function ghlCalendarAppointments(locationId, calendarId, startMs, endMs) {
    if (!calendarId) return [];
    const d = await locGet(locationId, `/calendars/events?locationId=${encodeURIComponent(locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${startMs}&endTime=${endMs}`);
    const events = d?.events || d?.appointments || [];
    return events.map(x => ({
        type: 'appointment', name: x.title || x.contactName || 'Booking',
        email: x.email || '', phone: x.phone || '', contact_id: x.contactId || '', at: x.startTime || x.createdAt || null
    }));
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
// Lower-cased tag list for a contact in a sub-account (via the location token).
export async function ghlContactTags(locationId, contactId) {
    if (!contactId) return [];
    try {
        const d = await locGet(locationId, `/contacts/${encodeURIComponent(contactId)}`);
        const c = (d && (d.contact || d)) || {};
        return Array.isArray(c.tags) ? c.tags.map(t => String(t).toLowerCase()) : [];
    } catch { return []; }
}

// Tags + opt-in page (attribution) for a contact, in one call.
// page = the URL captured when they opted in (last touch, else first touch).
export async function ghlContactInfo(locationId, contactId) {
    if (!contactId) return { tags: [], page: '', source: '' };
    try {
        const d = await locGet(locationId, `/contacts/${encodeURIComponent(contactId)}`);
        const c = (d && (d.contact || d)) || {};
        const tags = Array.isArray(c.tags) ? c.tags.map(t => String(t).toLowerCase()) : [];
        const la = c.lastAttributionSource || {};
        const fa = c.attributionSource || {};
        const page = la.url || fa.url || la.referrer || fa.referrer || '';
        const source = la.utmSource || fa.utmSource || la.sessionSource || la.medium || '';
        const campaign = la.campaign || la.utmCampaign || fa.campaign || fa.utmCampaign || '';
        const medium = la.utmMedium || la.medium || fa.utmMedium || '';
        return { tags, page, source, campaign, medium };
    } catch { return { tags: [], page: '', source: '' }; }
}

// Find a contact in a sub-account by email (lead-gen lookup). Returns a
// normalized contact or null. Uses the location token.
export async function ghlFindContactByEmail(locationId, email) {
    if (!locationId || !email) return null;
    const lt = await ghlLocationToken(locationId);
    if (!lt) return null;
    const headers = { 'Authorization': `Bearer ${lt}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/json' };
    try {
        // Preferred: exact duplicate lookup by email.
        let r = await fetch(`${GHL_BASE}/contacts/search/duplicate?locationId=${encodeURIComponent(locationId)}&email=${encodeURIComponent(email)}`, { headers });
        let c = null;
        if (r.ok) { const d = await r.json().catch(() => ({})); c = d?.contact || null; }
        if (!c) {
            // Fallback: query search.
            r = await fetch(`${GHL_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(email)}&limit=1`, { headers });
            if (r.ok) { const d = await r.json().catch(() => ({})); c = (d?.contacts || [])[0] || null; }
        }
        if (!c) return null;
        const la = c.lastAttributionSource || {}, fa = c.attributionSource || {};
        return {
            id: c.id, email: c.email || email,
            name: (`${c.firstName || ''} ${c.lastName || ''}`.trim()) || c.contactName || c.name || '',
            phone: c.phone || '', tags: Array.isArray(c.tags) ? c.tags : [],
            source: la.utmSource || la.sessionSource || fa.utmSource || c.source || '',
            date_added: c.dateAdded || c.createdAt || null
        };
    } catch { return null; }
}

// A contact's appointments (upcoming + past), normalized + sorted (soonest first).
export async function ghlContactAppointments(locationId, contactId) {
    if (!locationId || !contactId) return [];
    const lt = await ghlLocationToken(locationId);
    if (!lt) return [];
    try {
        const r = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/appointments`, {
            headers: { 'Authorization': `Bearer ${lt}`, 'Version': '2021-07-28', 'Accept': 'application/json' }
        });
        if (!r.ok) return [];
        const d = await r.json().catch(() => ({}));
        const events = d?.events || d?.appointments || [];
        return events.map(x => ({
            id: x.id, title: x.title || x.calendar?.name || 'Appointment',
            start: x.startTime || x.startAt || null, end: x.endTime || x.endAt || null,
            status: x.appointmentStatus || x.status || '',
            calendar: x.calendar?.name || x.calendarName || '',
            address: x.address || x.location || '', meeting_url: x.meetingUrl || x.address || '',
            // Who the appointment is booked with (for auto-assigning the rep).
            assigned_user_id: x.assignedUserId || x.userId || (x.assignedUser && x.assignedUser.id) || (x.user && x.user.id) || ''
        })).filter(a => a.start).sort((a, b) => new Date(a.start) - new Date(b.start));
    } catch { return []; }
}

// Search contacts in a sub-account that carry a given tag (lead-gen import).
export async function ghlSearchContactsByTag(locationId, tag, limit = 100) {
    if (!locationId || !tag) return [];
    const lt = await ghlLocationToken(locationId);
    if (!lt) return [];
    const headers = { 'Authorization': `Bearer ${lt}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/json' };
    try {
        const r = await fetch(`${GHL_BASE}/contacts/search`, {
            method: 'POST', headers,
            body: JSON.stringify({ locationId, page: 1, pageLimit: Math.min(100, limit), filters: [{ field: 'tags', operator: 'contains', value: String(tag).toLowerCase() }] })
        });
        if (!r.ok) return [];
        const d = await r.json().catch(() => ({}));
        return (d?.contacts || []).map(c => {
            const la = c.lastAttributionSource || {}, fa = c.attributionSource || {};
            return {
                id: c.id, email: c.email || '',
                name: (`${c.firstName || ''} ${c.lastName || ''}`.trim()) || c.contactName || '',
                phone: c.phone || '',
                source: la.utmSource || la.sessionSource || fa.utmSource || c.source || 'highlevel',
                date_added: c.dateAdded || c.createdAt || null
            };
        });
    } catch { return []; }
}

// Team members (users) in a sub-account, for matching app staff by email.
export async function ghlListUsers(locationId) {
    if (!locationId) return [];
    const lt = await ghlLocationToken(locationId);
    if (!lt) return [];
    try {
        const r = await fetch(`${GHL_BASE}/users/?locationId=${encodeURIComponent(locationId)}`, {
            headers: { 'Authorization': `Bearer ${lt}`, 'Version': '2021-07-28', 'Accept': 'application/json' }
        });
        if (!r.ok) return [];
        const d = await r.json().catch(() => ({}));
        return (d?.users || []).map(u => ({
            id: u.id, email: String(u.email || '').toLowerCase(),
            name: (`${u.firstName || ''} ${u.lastName || ''}`.trim()) || u.name || '',
            phone: u.phone || '', photo: u.profilePhoto || u.photo || u.avatar || '',
            role: (u.roles && (u.roles.role || u.roles.type)) || u.role || ''
        })).filter(u => u.email);
    } catch { return []; }
}

// Whitelabel deep link to a contact in the sub-account (the "secure tunnel").
// Staff must be signed into HighLevel; this just opens the right contact.
export function ghlContactLink(locationId, contactId) {
    if (!locationId || !contactId) return '';
    const host = process.env.GHL_APP_HOST || 'app.mypayprotec.com';
    return `https://${host}/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(contactId)}`;
}

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
