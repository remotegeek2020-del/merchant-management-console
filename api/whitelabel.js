// White-label Phase 2 — multi-tenant "agency" model + self-serve custom domains
// via Cloudflare for SaaS (Custom Hostnames).
//
// Hierarchy (HighLevel-style):
//   PayProTec  = super-agency (root, portal.mypayprotec.com — never white-labeled)
//   Partner    = an AGENCY that owns a white-label CRM portal, identified by a
//                stable Relationship ID (REL-######). Can register their own domain.
//   Sub-partner= a sub-account UNDER a partner. Logs into the parent's domain/brand
//                but sees only their own scoped CRM data. Inherits the parent portal.
//
// Cloudflare creds are read env-first, then encrypted app_config (same pattern as
// ShipStation), so an admin can paste them in Secret Dungeon without a redeploy:
//   CF_API_TOKEN   (token with "SSL and Certificates: Edit" on the zone)
//   CF_ZONE_ID     (the zone that owns the SaaS fallback origin)
//   CF_CNAME_TARGET(the fallback-origin hostname partners CNAME to, e.g. whitelabel.mypayprotec.com)

import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { loadActor, isAdminRole } from './_access.js';
import { getConfigValue, setConfigValue } from './api-config.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CF_API = 'https://api.cloudflare.com/client/v4';

function normHost(h) { return String(h || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split(':')[0].trim(); }
function isValidHost(h) { return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(h); }

// ── Cloudflare config (env-first, then encrypted app_config) ─────────────────
async function getCfConfig() {
    const token = process.env.CF_API_TOKEN || await getConfigValue('CF_API_TOKEN');
    const zone = process.env.CF_ZONE_ID || await getConfigValue('CF_ZONE_ID');
    const target = process.env.CF_CNAME_TARGET || await getConfigValue('CF_CNAME_TARGET') || '';
    return { token, zone, target: normHost(target) };
}
function cfConfigured(cf) { return !!(cf && cf.token && cf.zone); }

async function cfFetch(cf, path, opts = {}) {
    const res = await fetch(CF_API + path, {
        ...opts,
        headers: { 'Authorization': 'Bearer ' + cf.token, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { ok: res.ok && json && json.success !== false, status: res.status, json };
}

// Register a custom hostname with Cloudflare for SaaS. Returns { id, ssl, ownership }.
async function cfCreateHostname(cf, host) {
    const body = {
        hostname: host,
        ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } }
    };
    const r = await cfFetch(cf, `/zones/${cf.zone}/custom_hostnames`, { method: 'POST', body: JSON.stringify(body) });
    return r;
}
async function cfGetHostname(cf, id) {
    return cfFetch(cf, `/zones/${cf.zone}/custom_hostnames/${id}`, { method: 'GET' });
}
async function cfDeleteHostname(cf, id) {
    return cfFetch(cf, `/zones/${cf.zone}/custom_hostnames/${id}`, { method: 'DELETE' });
}

// Distill a Cloudflare custom-hostname record into the fields the portal needs.
function distillCf(rec, target) {
    const ssl = (rec && rec.ssl) || {};
    const status = rec ? rec.status : 'pending';                 // ownership/activation
    const sslStatus = ssl.status || 'pending';                   // certificate
    // Records the partner must add at their DNS to (a) point traffic and (b) prove
    // ownership for the certificate (HTTP method usually needs no TXT, but CF may ask).
    const dcv = (ssl.validation_records || []).map(v => ({ txt_name: v.txt_name, txt_value: v.txt_value, http_url: v.http_url, http_body: v.http_body }));
    const own = rec && rec.ownership_verification ? { name: rec.ownership_verification.name, value: rec.ownership_verification.value, type: rec.ownership_verification.type } : null;
    let phase = 'pending';
    if (status === 'active' && (sslStatus === 'active')) phase = 'active';
    else if (status === 'active') phase = 'ssl_pending';
    else phase = 'dns_pending';
    return { cf_status: status, ssl_status: sslStatus, phase, cname_target: target, dcv, ownership: own };
}

// Read-only fetch of a partner's portal (no creation — avoids burning a
// Relationship ID for partners who merely open their Settings page).
async function getPortal(personId) {
    const { data } = await supabase.from('partner_portals').select('*').eq('owner_person_id', personId).maybeSingle();
    return data || null;
}

// ── Tenancy: ensure a partner has an agency portal (with a Relationship ID) ───
// Only called when an admin GRANTS agency access (the moment a portal is real).
async function ensurePortal(personId, agencyName) {
    const { data: existing } = await supabase.from('partner_portals').select('*').eq('owner_person_id', personId).maybeSingle();
    if (existing) {
        if (agencyName && !existing.agency_name) {
            await supabase.from('partner_portals').update({ agency_name: agencyName, updated_at: new Date().toISOString() }).eq('id', existing.id);
            existing.agency_name = agencyName;
        }
        return existing;
    }
    const { data: rid } = await supabase.rpc('next_relationship_id');
    const { data: created } = await supabase.from('partner_portals')
        .insert({ owner_person_id: personId, relationship_id: rid, agency_name: agencyName || null })
        .select('*').single();
    return created;
}

// A partner's default agency name (for auto-fill): their company, else full name.
async function defaultAgencyName(personId) {
    const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).maybeSingle();
    const { data: ag } = await supabase.from('agents').select('companies:company_id(company_name)').eq('parent_agent_id', personId).limit(1);
    const company = ag && ag[0] && ag[0].companies && ag[0].companies.company_name;
    return company || (person && person.full_name) || 'My Agency';
}

async function validatePartner(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

// ── Agency membership (owners + admins) ──────────────────────────────────────
// Load a portal's members with person names, owners first, primary owner on top.
async function loadMembers(portalId) {
    const { data: members } = await supabase.from('partner_portal_members').select('*').eq('portal_id', portalId);
    const list = members || [];
    const pids = list.map(m => m.person_id).filter(Boolean);
    let people = {};
    if (pids.length) { const { data } = await supabase.from('persons').select('id, full_name, email').in('id', pids); (data || []).forEach(p => people[p.id] = p); }
    return list.map(m => ({
        id: m.id, person_id: m.person_id, role: m.role, is_primary: m.is_primary === true,
        ownership_percent: (m.ownership_percent === null || m.ownership_percent === undefined) ? null : Number(m.ownership_percent),
        full_name: (people[m.person_id] || {}).full_name || null,
        email: (people[m.person_id] || {}).email || null
    })).sort((a, b) => (b.is_primary - a.is_primary) || (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1));
}

// Ensure exactly one primary owner exists (does NOT touch owner_person_id, which is
// the stable ANCHOR = the partner this agency belongs to, used for lookup).
async function ensureOnePrimary(portalId) {
    const { data: owners } = await supabase.from('partner_portal_members').select('id, is_primary').eq('portal_id', portalId).eq('role', 'owner');
    const list = owners || [];
    if (!list.length) return;
    if (list.some(o => o.is_primary)) return;
    await supabase.from('partner_portal_members').update({ is_primary: true }).eq('id', list[0].id);
}

// Find the agency a person belongs to — by MEMBERSHIP, so co-owners see the same
// shared agency on each other's profiles (mutual ownership). Prefers the agency they
// anchor (their own company), then any agency they co-own / admin.
async function findPortalForPerson(personId) {
    if (!personId) return null;
    // 1. Their own anchored agency.
    const { data: anchored } = await supabase.from('partner_portals').select('*').eq('owner_person_id', personId).maybeSingle();
    if (anchored) return anchored;
    // 2. An agency they are a member of (co-owner or admin), primary membership first.
    const { data: mem } = await supabase.from('partner_portal_members')
        .select('portal_id, is_primary, role').eq('person_id', personId)
        .order('is_primary', { ascending: false });
    if (mem && mem.length) {
        // Prefer a membership where they're an owner.
        const owned = mem.find(x => x.role === 'owner') || mem[0];
        const { data } = await supabase.from('partner_portals').select('*').eq('id', owned.portal_id).maybeSingle();
        return data || null;
    }
    return null;
}

// Resolve a portal from an explicit portal_id, else the person's agency (by membership).
async function resolvePortal(body) {
    if (body.portal_id) { const { data } = await supabase.from('partner_portals').select('*').eq('id', body.portal_id).maybeSingle(); return data || null; }
    if (body.person_id) return findPortalForPerson(body.person_id);
    return null;
}

// Sync a Cloudflare status back into a portal_brands row.
async function refreshBrandStatus(cf, brandRow) {
    if (!brandRow || !brandRow.cf_hostname_id) return brandRow;
    const r = await cfGetHostname(cf, brandRow.cf_hostname_id);
    if (!r.ok) return brandRow;
    const d = distillCf(r.json.result, cf.target);
    const patch = { ssl_status: d.phase, verification: { cf_status: d.cf_status, ssl_status: d.ssl_status, dcv: d.dcv, ownership: d.ownership }, updated_at: new Date().toISOString() };
    // Auto-activate the brand once the certificate is live.
    if (d.phase === 'active') patch.active = true;
    await supabase.from('portal_brands').update(patch).eq('id', brandRow.id);
    return { ...brandRow, ...patch };
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const body = req.body || {};
    const action = body.action;

    try {
        // ─────────────────────── PARTNER (token) surface ───────────────────────
        if (['my_domain', 'add_domain', 'refresh_domain', 'remove_domain', 'set_agency_name'].includes(action)) {
            const personId = await validatePartner(body.token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });
            const cf = await getCfConfig();

            if (action === 'my_domain') {
                const portal = await getPortal(personId);
                if (!portal) return res.status(200).json({ success: true, agency_enabled: false });
                const agencyEnabled = portal.agency_enabled === true;
                let brand = null;
                if (agencyEnabled) {
                    const q = await supabase.from('portal_brands').select('*').eq('portal_id', portal.id).eq('added_by_partner', true).order('created_at', { ascending: false }).maybeSingle();
                    brand = q.data;
                    if (brand && cfConfigured(cf) && brand.cf_hostname_id && brand.ssl_status !== 'active') {
                        brand = await refreshBrandStatus(cf, brand);
                    }
                }
                return res.status(200).json({
                    success: true,
                    agency_enabled: agencyEnabled,
                    relationship_id: portal.relationship_id,
                    agency_name: portal.agency_name,
                    cname_target: cf.target || null,
                    cloudflare_ready: cfConfigured(cf),
                    domain: brand ? {
                        host: brand.host, status: brand.ssl_status,
                        verification: brand.verification || null, active: brand.active
                    } : null
                });
            }

            if (action === 'set_agency_name') {
                const portal = await getPortal(personId);
                if (!portal || portal.agency_enabled !== true) return res.status(403).json({ success: false, message: 'Agency access is not enabled.' });
                await supabase.from('partner_portals').update({ agency_name: (body.agency_name || '').trim() || null, updated_at: new Date().toISOString() }).eq('id', portal.id);
                return res.status(200).json({ success: true });
            }

            if (action === 'add_domain') {
                // Gate: only partners granted agency access may connect a domain.
                const gp = await getPortal(personId);
                if (!gp || gp.agency_enabled !== true) return res.status(403).json({ success: false, message: 'White-label agency access is not enabled on your account. Please contact your PayProTec representative.' });
                const host = normHost(body.host);
                if (!isValidHost(host)) return res.status(400).json({ success: false, message: 'Enter a valid domain, e.g. app.yourbrand.com' });
                // Never allow hijacking our own canonical hosts.
                if (/(^|\.)mypayprotec\.com$/.test(host) && host !== cf.target) {
                    // allow only if it's a subdomain the admin explicitly delegated — default: block
                }
                if (!cfConfigured(cf)) return res.status(503).json({ success: false, message: 'Custom domains are not enabled yet. Please contact support.' });
                // One host globally — reject if already claimed by someone else.
                const { data: taken } = await supabase.from('portal_brands').select('id, partner_id').eq('host', host).maybeSingle();
                if (taken && taken.partner_id && taken.partner_id !== personId) {
                    return res.status(409).json({ success: false, message: 'That domain is already in use.' });
                }
                // Reuse the granted portal; backfill a default agency name if empty.
                let portal = gp;
                if (!portal.agency_name) {
                    const nm = await defaultAgencyName(personId);
                    await supabase.from('partner_portals').update({ agency_name: nm, updated_at: new Date().toISOString() }).eq('id', portal.id);
                    portal = { ...portal, agency_name: nm };
                }

                const cr = await cfCreateHostname(cf, host);
                if (!cr.ok) {
                    const msg = (cr.json && cr.json.errors && cr.json.errors[0] && cr.json.errors[0].message) || 'Cloudflare rejected the domain.';
                    return res.status(502).json({ success: false, message: msg });
                }
                const d = distillCf(cr.json.result, cf.target);
                const row = {
                    host, partner_id: personId, portal_id: portal.id, added_by_partner: true,
                    name: portal.agency_name || null, cf_hostname_id: cr.json.result.id,
                    ssl_status: d.phase, verification: { cf_status: d.cf_status, ssl_status: d.ssl_status, dcv: d.dcv, ownership: d.ownership },
                    cname_target: cf.target, active: false, updated_at: new Date().toISOString()
                };
                if (taken) await supabase.from('portal_brands').update(row).eq('id', taken.id);
                else await supabase.from('portal_brands').upsert(row, { onConflict: 'host' });
                return res.status(200).json({ success: true, host, cname_target: cf.target, status: d.phase, verification: row.verification });
            }

            if (action === 'refresh_domain') {
                const portal = await getPortal(personId);
                if (!portal) return res.status(404).json({ success: false, message: 'No domain to refresh.' });
                const { data: brand } = await supabase.from('portal_brands').select('*').eq('portal_id', portal.id).eq('added_by_partner', true).order('created_at', { ascending: false }).maybeSingle();
                if (!brand) return res.status(404).json({ success: false, message: 'No domain to refresh.' });
                if (!cfConfigured(cf)) return res.status(503).json({ success: false, message: 'Custom domains are not enabled yet.' });
                const b = await refreshBrandStatus(cf, brand);
                return res.status(200).json({ success: true, host: b.host, status: b.ssl_status, verification: b.verification, active: b.active });
            }

            if (action === 'remove_domain') {
                const portal = await getPortal(personId);
                if (!portal) return res.status(200).json({ success: true });
                const { data: brand } = await supabase.from('portal_brands').select('*').eq('portal_id', portal.id).eq('added_by_partner', true).order('created_at', { ascending: false }).maybeSingle();
                if (!brand) return res.status(200).json({ success: true });
                if (brand.cf_hostname_id && cfConfigured(cf)) { try { await cfDeleteHostname(cf, brand.cf_hostname_id); } catch (e) {} }
                await supabase.from('portal_brands').delete().eq('id', brand.id);
                return res.status(200).json({ success: true });
            }
        }

        // ─────────────────────── ADMIN (staff) surface ─────────────────────────
        const session = await validateSession(req);
        if (!session) return sessionErrorResponse(res);
        const actor = await loadActor(session.userid);
        if (!isAdminRole(actor)) return res.status(403).json({ success: false, message: 'Admin only.' });

        if (action === 'cf_config_get') {
            const cf = await getCfConfig();
            return res.status(200).json({
                success: true,
                configured: cfConfigured(cf),
                zone_set: !!cf.zone, token_set: !!cf.token,
                cname_target: cf.target || ''
            });
        }
        if (action === 'cf_config_set') {
            const c = body.config || {};
            if (typeof c.token === 'string' && c.token && !/^\*+$/.test(c.token)) await setConfigValue('CF_API_TOKEN', c.token.trim(), actor.userid || 'admin');
            if (typeof c.zone === 'string') await setConfigValue('CF_ZONE_ID', c.zone.trim(), actor.userid || 'admin');
            if (typeof c.target === 'string') await setConfigValue('CF_CNAME_TARGET', normHost(c.target), actor.userid || 'admin');
            const cf = await getCfConfig();
            return res.status(200).json({ success: true, configured: cfConfigured(cf), cname_target: cf.target || '' });
        }

        // Grant / revoke a partner's white-label agency access (staff, per-partner).
        if (action === 'set_agency_access') {
            const personId = body.person_id;
            if (!personId) return res.status(400).json({ success: false, message: 'person_id required.' });
            const enabled = body.enabled === true || body.enabled === 'true';
            // Toggle the SHARED agency this person belongs to (co-owner or anchor). Only
            // create a new one (anchored to them) if they don't belong to any yet.
            let portal = await findPortalForPerson(personId);
            if (!portal) {
                if (!enabled) return res.status(200).json({ success: true, agency_enabled: false, relationship_id: null });
                portal = await ensurePortal(personId, body.agency_name || null);
            }
            await supabase.from('partner_portals').update({ agency_enabled: enabled, updated_at: new Date().toISOString() }).eq('id', portal.id);
            // Seed the granted partner as the primary owner (idempotent).
            if (enabled) {
                const { data: existing } = await supabase.from('partner_portal_members').select('id').eq('portal_id', portal.id).eq('person_id', personId).maybeSingle();
                if (!existing) {
                    const { data: anyPrimary } = await supabase.from('partner_portal_members').select('id').eq('portal_id', portal.id).eq('is_primary', true).maybeSingle();
                    await supabase.from('partner_portal_members').insert({ portal_id: portal.id, person_id: personId, role: 'owner', is_primary: !anyPrimary, added_by: actor.userid || 'admin' });
                }
                await ensureOnePrimary(portal.id);
            }
            // If revoking, deactivate any live custom domain so the brand stops resolving.
            if (!enabled) {
                await supabase.from('portal_brands').update({ active: false }).eq('portal_id', portal.id).eq('added_by_partner', true);
            }
            return res.status(200).json({ success: true, agency_enabled: enabled, relationship_id: portal.relationship_id });
        }

        // Read a partner's agency status (staff — used by the partners dashboard toggle).
        if (action === 'get_agency_access') {
            const personId = body.person_id;
            if (!personId) return res.status(400).json({ success: false, message: 'person_id required.' });
            // The agency this person belongs to (their own, or one they co-own) — shared,
            // so co-owners reflect each other's ownership on both profiles.
            const portal = await findPortalForPerson(personId);
            let domain = null, members = [];
            if (portal) {
                const { data: b } = await supabase.from('portal_brands').select('host, ssl_status, active').eq('portal_id', portal.id).eq('added_by_partner', true).maybeSingle();
                domain = b || null;
                members = await loadMembers(portal.id);
            }
            const isAnchor = !!(portal && portal.owner_person_id === personId);
            return res.status(200).json({
                success: true,
                agency_enabled: !!(portal && portal.agency_enabled),
                portal_id: portal ? portal.id : null,
                relationship_id: portal ? portal.relationship_id : null,
                agency_name: portal ? portal.agency_name : null,
                is_anchor: isAnchor,
                domain, members
            });
        }

        // Server-side people search for the owner/admin picker (searches ALL partners,
        // not just what the dashboard has loaded client-side).
        if (action === 'search_people') {
            const q = String(body.q || '').trim();
            if (q.length < 2) return res.status(200).json({ success: true, people: [] });
            const like = `%${q.replace(/[%_]/g, '')}%`;
            const { data } = await supabase.from('persons')
                .select('id, full_name, email')
                .or(`full_name.ilike.${like},email.ilike.${like}`)
                .order('full_name', { ascending: true })
                .limit(12);
            return res.status(200).json({ success: true, people: data || [] });
        }

        // ── Owners & admins management (staff) ──────────────────────────────────
        if (action === 'get_members') {
            const portal = await resolvePortal(body);
            if (!portal) return res.status(200).json({ success: true, members: [], portal_id: null });
            return res.status(200).json({ success: true, portal_id: portal.id, relationship_id: portal.relationship_id, members: await loadMembers(portal.id) });
        }

        // Parse an optional ownership percentage (0–100, or null to clear).
        const parsePct = (v) => {
            if (v === '' || v === null || v === undefined) return null;
            const n = Number(v);
            if (!isFinite(n) || n < 0 || n > 100) return undefined; // undefined = invalid
            return n;
        };

        if (action === 'add_member') {
            if (!body.member_person_id) return res.status(400).json({ success: false, message: 'member_person_id required.' });
            // Recording ownership shouldn't require white-label first — auto-create the
            // agency (anchored to the partner) if it doesn't exist yet.
            let portal = await resolvePortal(body);
            if (!portal && body.person_id) portal = await ensurePortal(body.person_id, body.agency_name || null);
            if (!portal) return res.status(404).json({ success: false, message: 'Could not resolve the agency.' });
            const role = body.role === 'owner' ? 'owner' : 'admin';
            const pct = parsePct(body.ownership_percent);
            if (pct === undefined) return res.status(400).json({ success: false, message: 'Ownership % must be between 0 and 100.' });
            const row = { portal_id: portal.id, person_id: body.member_person_id, role, added_by: actor.userid || 'admin' };
            if (role === 'owner') row.ownership_percent = pct; else row.ownership_percent = null;
            const { error } = await supabase.from('partner_portal_members').upsert(row, { onConflict: 'portal_id,person_id' });
            if (error) return res.status(500).json({ success: false, message: 'Could not add member.' });
            await ensureOnePrimary(portal.id);
            return res.status(200).json({ success: true, portal_id: portal.id, relationship_id: portal.relationship_id, members: await loadMembers(portal.id) });
        }

        if (action === 'set_ownership_percent') {
            const { data: m } = await supabase.from('partner_portal_members').select('*').eq('id', body.member_id).maybeSingle();
            if (!m) return res.status(404).json({ success: false, message: 'Member not found.' });
            const pct = parsePct(body.ownership_percent);
            if (pct === undefined) return res.status(400).json({ success: false, message: 'Ownership % must be between 0 and 100.' });
            await supabase.from('partner_portal_members').update({ ownership_percent: pct }).eq('id', m.id);
            return res.status(200).json({ success: true, portal_id: m.portal_id, members: await loadMembers(m.portal_id) });
        }

        if (action === 'set_member_role') {
            const { data: m } = await supabase.from('partner_portal_members').select('*').eq('id', body.member_id).maybeSingle();
            if (!m) return res.status(404).json({ success: false, message: 'Member not found.' });
            const role = body.role === 'owner' ? 'owner' : 'admin';
            // Demoting the primary owner is not allowed — transfer primary first.
            if (m.is_primary && role !== 'owner') return res.status(400).json({ success: false, message: 'Transfer the primary owner before demoting this person.' });
            const patch = { role };
            if (role === 'admin') patch.ownership_percent = null; // admins hold no stake
            await supabase.from('partner_portal_members').update(patch).eq('id', m.id);
            await ensureOnePrimary(m.portal_id);
            return res.status(200).json({ success: true, portal_id: m.portal_id, members: await loadMembers(m.portal_id) });
        }

        if (action === 'set_primary_owner') {
            const portal = await resolvePortal(body);
            if (!portal) return res.status(404).json({ success: false, message: 'Agency not found.' });
            if (!body.member_person_id) return res.status(400).json({ success: false, message: 'member_person_id required.' });
            // The new primary must be an owner.
            await supabase.from('partner_portal_members').update({ is_primary: false }).eq('portal_id', portal.id);
            await supabase.from('partner_portal_members').upsert(
                { portal_id: portal.id, person_id: body.member_person_id, role: 'owner', is_primary: true, added_by: actor.userid || 'admin' },
                { onConflict: 'portal_id,person_id' });
            return res.status(200).json({ success: true, portal_id: portal.id, members: await loadMembers(portal.id) });
        }

        if (action === 'remove_member') {
            const { data: m } = await supabase.from('partner_portal_members').select('*').eq('id', body.member_id).maybeSingle();
            if (!m) return res.status(200).json({ success: true });
            if (m.is_primary) return res.status(400).json({ success: false, message: 'Cannot remove the primary owner. Transfer primary ownership first.' });
            await supabase.from('partner_portal_members').delete().eq('id', m.id);
            await ensureOnePrimary(m.portal_id);
            return res.status(200).json({ success: true, portal_id: m.portal_id, members: await loadMembers(m.portal_id) });
        }

        // All agency portals + their domains (management overview).
        if (action === 'list_portals') {
            const { data: portals } = await supabase.from('partner_portals').select('*').order('created_at', { ascending: false });
            const ids = (portals || []).map(p => p.id);
            let brands = [];
            if (ids.length) { const { data } = await supabase.from('portal_brands').select('id, host, portal_id, ssl_status, active, added_by_partner').in('portal_id', ids); brands = data || []; }
            // All members across these portals, enriched with names.
            let membersByPortal = {};
            if (ids.length) {
                const { data: mem } = await supabase.from('partner_portal_members').select('*').in('portal_id', ids);
                const mpids = [...new Set((mem || []).map(m => m.person_id).filter(Boolean))];
                let people = {};
                if (mpids.length) { const { data } = await supabase.from('persons').select('id, full_name, email').in('id', mpids); (data || []).forEach(p => people[p.id] = p); }
                (mem || []).forEach(m => {
                    (membersByPortal[m.portal_id] = membersByPortal[m.portal_id] || []).push({
                        person_id: m.person_id, role: m.role, is_primary: m.is_primary === true,
                        ownership_percent: (m.ownership_percent === null || m.ownership_percent === undefined) ? null : Number(m.ownership_percent),
                        full_name: (people[m.person_id] || {}).full_name || null,
                        email: (people[m.person_id] || {}).email || null
                    });
                });
            }
            const out = (portals || []).map(p => {
                const mem = (membersByPortal[p.id] || []).sort((a, b) => (b.is_primary - a.is_primary) || (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1));
                return {
                    ...p,
                    owners: mem.filter(m => m.role === 'owner'),
                    admins: mem.filter(m => m.role === 'admin'),
                    domains: brands.filter(b => b.portal_id === p.id)
                };
            });
            return res.status(200).json({ success: true, portals: out });
        }

        // Refresh a specific domain's Cloudflare status on demand (admin).
        if (action === 'admin_refresh_domain') {
            const cf = await getCfConfig();
            if (!cfConfigured(cf)) return res.status(503).json({ success: false, message: 'Cloudflare not configured.' });
            const { data: brand } = await supabase.from('portal_brands').select('*').eq('id', body.brand_id).maybeSingle();
            if (!brand) return res.status(404).json({ success: false, message: 'Not found.' });
            const b = await refreshBrandStatus(cf, brand);
            return res.status(200).json({ success: true, status: b.ssl_status, verification: b.verification, active: b.active });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[whitelabel]', err && err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
}
