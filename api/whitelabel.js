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

// ── Vercel config (env-first, then encrypted app_config) ─────────────────────
// So partner-connected domains auto-register with the Vercel project (Vercel routes by
// Host and 404s unknown domains). Needs a token with access to the project.
async function getVercelConfig() {
    const token = process.env.VERCEL_TOKEN || await getConfigValue('VERCEL_TOKEN');
    const project = process.env.VERCEL_PROJECT_ID || await getConfigValue('VERCEL_PROJECT_ID');
    const team = process.env.VERCEL_TEAM_ID || await getConfigValue('VERCEL_TEAM_ID') || '';
    return { token, project, team };
}
function vercelConfigured(v) { return !!(v && v.token && v.project); }
async function vercelFetch(v, path, opts = {}) {
    const teamQ = v.team ? (path.indexOf('?') >= 0 ? '&' : '?') + 'teamId=' + encodeURIComponent(v.team) : '';
    const res = await fetch('https://api.vercel.com' + path + teamQ, {
        ...opts,
        headers: { 'Authorization': 'Bearer ' + v.token, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    let json = null; try { json = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, json };
}
// Register a domain with the Vercel project (idempotent — 409 = already added).
async function vercelAddDomain(host) {
    const v = await getVercelConfig();
    if (!vercelConfigured(v)) return { skipped: true };
    const r = await vercelFetch(v, `/v10/projects/${v.project}/domains`, { method: 'POST', body: JSON.stringify({ name: host }) });
    if (r.ok) return { ok: true };
    const code = r.json && r.json.error && r.json.error.code;
    if (r.status === 409 || code === 'domain_already_in_use' || code === 'domain_already_exists') return { ok: true, existed: true };
    return { ok: false, message: (r.json && r.json.error && r.json.error.message) || 'Vercel add failed' };
}
async function vercelRemoveDomain(host) {
    const v = await getVercelConfig();
    if (!vercelConfigured(v)) return { skipped: true };
    try { await vercelFetch(v, `/v9/projects/${v.project}/domains/${encodeURIComponent(host)}`, { method: 'DELETE' }); } catch (e) {}
    return { ok: true };
}

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
        // TXT DCV: the certificate validates via a DNS TXT record, so it does NOT require
        // the origin to be reachable first (HTTP DCV does). More reliable for onboarding.
        ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } }
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

// The companies that belong to an agency = the companies of its OWNER members
// (plus the anchor owner). Returns { company_id: company_name }. Two-step lookup (no
// embedded FK join) for reliability.
async function agencyCompanies(portalId) {
    const { data: owners } = await supabase.from('partner_portal_members').select('person_id').eq('portal_id', portalId).eq('role', 'owner');
    const ownerIds = (owners || []).map(o => o.person_id).filter(Boolean);
    const { data: pp } = await supabase.from('partner_portals').select('owner_person_id').eq('id', portalId).maybeSingle();
    if (pp && pp.owner_person_id) ownerIds.push(pp.owner_person_id);
    const uniqOwners = [...new Set(ownerIds)];
    const map = {};
    if (!uniqOwners.length) return map;
    const { data: ags } = await supabase.from('agents').select('company_id').in('parent_agent_id', uniqOwners);
    const cids = [...new Set((ags || []).map(a => a.company_id).filter(Boolean))];
    if (!cids.length) return map;
    const { data: comps } = await supabase.from('companies').select('id, company_name').in('id', cids);
    (comps || []).forEach(c => { map[c.id] = c.company_name || 'Company'; });
    cids.forEach(cid => { if (!map[cid]) map[cid] = 'Company'; });
    return map;
}

// Agency branding fields (kept on partner_portals; mirrored to each domain's brand row).
const BRAND_FIELDS = ['logo_url', 'favicon_url', 'color_primary', 'color_dark', 'color_accent', 'support_email'];
// Push the agency's branding onto every custom-domain brand row so the live white-label
// portal (resolved by host from portal_brands) reflects it.
async function syncBrandingToDomains(portalId, agencyName) {
    const { data: portal } = await supabase.from('partner_portals').select('*').eq('id', portalId).maybeSingle();
    if (!portal) return;
    const patch = { name: agencyName || portal.agency_name || null, updated_at: new Date().toISOString() };
    BRAND_FIELDS.forEach(f => { patch[f] = portal[f] || null; });
    await supabase.from('portal_brands').update(patch).eq('portal_id', portalId).eq('added_by_partner', true);
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

// God-mode account: a platform super-user who sees & can enter EVERY agency.
async function isGod(personId) {
    if (!personId) return false;
    const { data } = await supabase.from('persons').select('is_portal_god').eq('id', personId).maybeSingle();
    return !!(data && data.is_portal_god);
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
        full_access: m.full_access === true,
        scope: m.scope || {},
        sub_account_ids: (m.scope && Array.isArray(m.scope.sub_account_ids)) ? m.scope.sub_account_ids : [],
        ownership_percent: (m.ownership_percent === null || m.ownership_percent === undefined) ? null : Number(m.ownership_percent),
        full_name: (people[m.person_id] || {}).full_name || null,
        email: (people[m.person_id] || {}).email || null
    })).sort((a, b) => (b.is_primary - a.is_primary) || (a.role === b.role ? 0 : a.role === 'owner' ? -1 : 1));
}

// The agency's sub-agents (people who are sub-partners under the agency's companies'
// partner IDs) — the natural candidates an owner can grant scoped portal access to.
async function agencySubAgents(portalId) {
    const companies = await agencyCompanies(portalId);
    const companyIds = Object.keys(companies);
    if (!companyIds.length) return [];
    const { data: ags } = await supabase.from('agents').select('id').in('company_id', companyIds);
    const agentUuids = (ags || []).map(a => a.id);
    if (!agentUuids.length) return [];
    const { data: compIdents } = await supabase.from('agent_identifiers').select('id').in('agent_id', agentUuids);
    const parentIds = (compIdents || []).map(i => i.id);
    if (!parentIds.length) return [];
    const { data: subIdents } = await supabase.from('agent_identifiers').select('agent_id').in('parent_config_id', parentIds);
    const subAgentIds = [...new Set((subIdents || []).map(s => s.agent_id))];
    if (!subAgentIds.length) return [];
    const { data: subAgents } = await supabase.from('agents').select('parent_agent_id').in('id', subAgentIds);
    const personIds = [...new Set((subAgents || []).map(a => a.parent_agent_id).filter(Boolean))];
    if (!personIds.length) return [];
    const { data: people } = await supabase.from('persons').select('id, full_name, email').in('id', personIds);
    return people || [];
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
        if (['my_domain', 'add_domain', 'refresh_domain', 'remove_domain', 'set_agency_name', 'get_my_agencies', 'get_sub_account', 'get_agency_overview',
             'list_sub_accounts', 'create_sub_account', 'delete_sub_account', 'my_companies',
             'agency_team', 'agency_grant', 'agency_set_scope', 'agency_revoke',
             'get_agency_branding', 'save_agency_branding'].includes(action)) {
            const personId = await validatePartner(body.token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });
            const cf = await getCfConfig();

            // Open a sub-account's CRM workspace: its details + scoped object counts/data.
            // A sub-account is the CRM tenant that holds merchants, leads, sub-partners and
            // affiliates. Merchants come from the linked company (real data); the other
            // objects are seeded empty until their sources are wired.
            if (action === 'get_sub_account') {
                const { data: sub } = await supabase.from('agency_sub_accounts').select('*').eq('id', body.sub_account_id).maybeSingle();
                if (!sub) return res.status(404).json({ success: false, message: 'Sub-account not found.' });
                // Access control: must be a member of the owning agency (sub-partners must
                // have this sub-account explicitly in their granted scope).
                const god = await isGod(personId);
                const { data: mem } = await supabase.from('partner_portal_members').select('*').eq('portal_id', sub.portal_id).eq('person_id', personId).maybeSingle();
                if (!mem && !god) return res.status(403).json({ success: false, message: 'You do not have access to this sub-account.' });
                if (!god && mem.role === 'sub_partner') {
                    const granted = (mem.scope && Array.isArray(mem.scope.sub_account_ids)) ? mem.scope.sub_account_ids : [];
                    if (!granted.includes(sub.id)) return res.status(403).json({ success: false, message: 'This sub-account is outside your granted access.' });
                }
                const { data: portal } = await supabase.from('partner_portals').select('id, relationship_id, agency_name').eq('id', sub.portal_id).maybeSingle();
                let companyName = null;
                let merchants = { count: 0, volume_30_day: 0, sample: [] };
                let partnerIds = [];                          // the company's agent IDs (the breakdown)
                let subPartners = { count: 0, sample: [] };   // sub-agents tied to those partner IDs
                if (sub.company_id) {
                    const { data: comp } = await supabase.from('companies').select('company_name').eq('id', sub.company_id).maybeSingle();
                    companyName = comp && comp.company_name;
                    // Company → agents → identifiers (the Partner IDs)
                    const { data: ags } = await supabase.from('agents').select('id').eq('company_id', sub.company_id);
                    const agentUuids = (ags || []).map(a => a.id);
                    let compIdents = [];
                    if (agentUuids.length) { const { data: ids } = await supabase.from('agent_identifiers').select('id, id_string, rev_share, prime49').in('agent_id', agentUuids); compIdents = ids || []; }
                    const idStrings = compIdents.map(i => i.id_string);

                    // Partner IDs with per-ID merchant counts (shows the alignment).
                    partnerIds = await Promise.all(compIdents.map(async i => {
                        const { count } = await supabase.from('merchants').select('id', { count: 'exact', head: true }).eq('agent_id', i.id_string);
                        return { id_string: i.id_string, rev_share: i.rev_share, prime49: i.prime49 === true, merchant_count: count || 0 };
                    }));

                    // Merchants under those Partner IDs (each row carries its partner ID = agent_id).
                    if (idStrings.length) {
                        const { data: mData, count } = await supabase.from('merchants')
                            .select('id, dba_name, account_status, volume_30_day, merchant_city, merchant_state, agent_id', { count: 'exact' })
                            .in('agent_id', idStrings).order('volume_30_day', { ascending: false, nullsFirst: false }).limit(25);
                        merchants.count = count || 0;
                        merchants.sample = mData || [];
                    }

                    // Sub-agents (sub-partners) tied to this company's Partner IDs
                    const parentIdentIds = compIdents.map(i => i.id);
                    if (parentIdentIds.length) {
                        const { data: subIdents } = await supabase.from('agent_identifiers').select('id, agent_id, id_string, rev_share').in('parent_config_id', parentIdentIds);
                        const subAgentIds = [...new Set((subIdents || []).map(s => s.agent_id))];
                        let agentToPerson = {};
                        if (subAgentIds.length) { const { data: subAgents } = await supabase.from('agents').select('id, parent_agent_id').in('id', subAgentIds); (subAgents || []).forEach(a => { agentToPerson[a.id] = a.parent_agent_id; }); }
                        const personIds = [...new Set(Object.values(agentToPerson).filter(Boolean))];
                        let people = {};
                        if (personIds.length) { const { data: ps } = await supabase.from('persons').select('id, full_name, email').in('id', personIds); (ps || []).forEach(p => { people[p.id] = p; }); }
                        const list = (subIdents || []).map(s => { const pe = people[agentToPerson[s.agent_id]] || {}; return { id_string: s.id_string, rev_share: s.rev_share, full_name: pe.full_name || null, email: pe.email || null }; });
                        subPartners = { count: list.length, sample: list.slice(0, 50) };
                    }
                }
                return res.status(200).json({
                    success: true,
                    sub_account: { id: sub.id, name: sub.name, type: sub.company_id ? 'company' : 'client', company_id: sub.company_id, company_name: companyName },
                    agency: portal ? { portal_id: portal.id, relationship_id: portal.relationship_id, agency_name: portal.agency_name } : null,
                    my_role: god ? 'god' : mem.role,
                    objects: {
                        merchants,
                        partner_ids: { count: partnerIds.length, sample: partnerIds },
                        leads: { count: 0, sample: [] },
                        sub_partners: subPartners,
                        affiliates: { count: 0, sample: [] }
                    }
                });
            }

            // Agency Home: the owner's "see all" view — aggregate roll-up across every
            // sub-account, the sub-account list with per-sub counts, and the team.
            if (action === 'get_agency_overview') {
                const portal = body.portal_id
                    ? (await supabase.from('partner_portals').select('*').eq('id', body.portal_id).maybeSingle()).data
                    : await findPortalForPerson(personId);
                if (!portal) return res.status(404).json({ success: false, message: 'Agency not found.' });
                const god = await isGod(personId);
                const { data: mem } = await supabase.from('partner_portal_members').select('*').eq('portal_id', portal.id).eq('person_id', personId).maybeSingle();
                if (!mem && !god) return res.status(403).json({ success: false, message: 'You do not belong to this agency.' });
                const role = god ? 'god' : (mem.role || 'admin');
                const canManage = god || role === 'admin' || (role === 'owner' && (mem.is_primary === true || mem.full_access === true));

                let { data: subs } = await supabase.from('agency_sub_accounts').select('id, company_id, name, status').eq('portal_id', portal.id).order('created_at', { ascending: true });
                subs = subs || [];
                if (!god && role === 'sub_partner') {
                    const granted = (mem.scope && Array.isArray(mem.scope.sub_account_ids)) ? mem.scope.sub_account_ids : [];
                    subs = subs.filter(s => granted.includes(s.id));
                }

                let totalMerchants = 0, totalPartnerIds = 0, totalSubAgents = 0;
                const subList = [];
                for (const s of subs) {
                    let mCount = 0, pidCount = 0, saCount = 0;
                    if (s.company_id) {
                        const { data: ags } = await supabase.from('agents').select('id').eq('company_id', s.company_id);
                        const agentUuids = (ags || []).map(a => a.id);
                        let compIdents = [];
                        if (agentUuids.length) { const { data: ids } = await supabase.from('agent_identifiers').select('id, id_string').in('agent_id', agentUuids); compIdents = ids || []; }
                        pidCount = compIdents.length;
                        const idStrings = compIdents.map(i => i.id_string);
                        if (idStrings.length) { const { count } = await supabase.from('merchants').select('id', { count: 'exact', head: true }).in('agent_id', idStrings); mCount = count || 0; }
                        const parentIdentIds = compIdents.map(i => i.id);
                        if (parentIdentIds.length) { const { count } = await supabase.from('agent_identifiers').select('id', { count: 'exact', head: true }).in('parent_config_id', parentIdentIds); saCount = count || 0; }
                    }
                    totalMerchants += mCount; totalPartnerIds += pidCount; totalSubAgents += saCount;
                    subList.push({ id: s.id, name: s.name, type: s.company_id ? 'company' : 'client', company_id: s.company_id, merchants: mCount, partner_ids: pidCount, sub_agents: saCount });
                }

                const { data: dom } = await supabase.from('portal_brands').select('host, ssl_status, active').eq('portal_id', portal.id).eq('added_by_partner', true).maybeSingle();
                return res.status(200).json({
                    success: true,
                    agency: {
                        portal_id: portal.id, relationship_id: portal.relationship_id, agency_name: portal.agency_name,
                        agency_enabled: portal.agency_enabled === true, domain: dom || null,
                        my_role: role, can_manage: canManage
                    },
                    kpis: { sub_accounts: subs.length, merchants: totalMerchants, partner_ids: totalPartnerIds, sub_agents: totalSubAgents },
                    sub_accounts: subList,
                    members: await loadMembers(portal.id)
                });
            }

            // The launchpad: every agency this person belongs to (owned + accessed) with
            // their role and the SUB-ACCOUNTS they can see there (created explicitly by the
            // partner — a linked company or a free-form client), plus the person's own
            // PayProTec companies (available to add as sub-accounts / work standard).
            if (action === 'get_my_agencies') {
                const { data: person } = await supabase.from('persons').select('id, full_name, email').eq('id', personId).maybeSingle();
                const god = await isGod(personId);
                // God sees ALL agencies; everyone else sees the ones they're a member of.
                let memberships = [];
                let portals = [];
                if (god) {
                    portals = (await supabase.from('partner_portals').select('*').order('created_at', { ascending: true })).data || [];
                } else {
                    memberships = (await supabase.from('partner_portal_members').select('*').eq('person_id', personId)).data || [];
                    const pIds = [...new Set(memberships.map(m => m.portal_id))];
                    if (pIds.length) portals = (await supabase.from('partner_portals').select('*').in('id', pIds)).data || [];
                }
                const portalIds = portals.map(p => p.id);

                let subRows = [], domains = {};
                if (portalIds.length) {
                    const [sRes, dRes] = await Promise.all([
                        supabase.from('agency_sub_accounts').select('id, portal_id, company_id, name, status').in('portal_id', portalIds),
                        supabase.from('portal_brands').select('portal_id, host, ssl_status, active').eq('added_by_partner', true).in('portal_id', portalIds)
                    ]);
                    subRows = sRes.data || [];
                    (dRes.data || []).forEach(d => { if (!domains[d.portal_id]) domains[d.portal_id] = d; });
                }

                const agencies = portals.map(p => {
                    const mem = god ? { role: 'owner', full_access: true } : ((memberships || []).find(m => m.portal_id === p.id) || {});
                    const role = mem.role || 'admin';
                    const isOwner = role === 'owner';
                    const canManage = god || role === 'admin' || (isOwner && (mem.is_primary === true || mem.full_access === true));
                    let subs = subRows.filter(r => r.portal_id === p.id).map(r => ({ id: r.id, name: r.name, company_id: r.company_id, type: r.company_id ? 'company' : 'client' }));
                    // Sub-partner: nothing until explicitly granted (scope.sub_account_ids).
                    if (!god && role === 'sub_partner') {
                        const granted = (mem.scope && Array.isArray(mem.scope.sub_account_ids)) ? mem.scope.sub_account_ids : [];
                        subs = subs.filter(s => granted.includes(s.id));
                    }
                    return {
                        portal_id: p.id, relationship_id: p.relationship_id, agency_name: p.agency_name,
                        agency_enabled: p.agency_enabled === true,
                        my_role: god ? 'god' : role, is_primary: mem.is_primary === true, full_access: god || mem.full_access === true,
                        is_owner: isOwner || god, can_manage: canManage, god: god,
                        domain: domains[p.id] || null, sub_accounts: subs
                    };
                });

                // The person's own PayProTec companies (for the sub-account picker + standard access).
                const { data: myAgents } = await supabase.from('agents').select('company_id, companies:company_id(company_name)').eq('parent_agent_id', personId);
                const owned = {};
                (myAgents || []).forEach(a => { if (a.company_id) owned[a.company_id] = (a.companies && a.companies.company_name) || 'Company'; });
                const companies = Object.keys(owned).map(cid => ({ company_id: cid, company_name: owned[cid] }));

                return res.status(200).json({ success: true, person: person || null, agencies, companies });
            }

            // ── Sub-account self-service (owners + admins; co-owners need full_access) ──
            if (['list_sub_accounts', 'create_sub_account', 'delete_sub_account', 'my_companies',
                 'agency_team', 'agency_grant', 'agency_set_scope', 'agency_revoke',
                 'get_agency_branding', 'save_agency_branding'].includes(action)) {
                const portal = body.portal_id
                    ? (await supabase.from('partner_portals').select('*').eq('id', body.portal_id).maybeSingle()).data
                    : await findPortalForPerson(personId);
                if (!portal) return res.status(404).json({ success: false, message: 'Agency not found.' });
                const god = await isGod(personId);
                const { data: mem } = await supabase.from('partner_portal_members').select('*').eq('portal_id', portal.id).eq('person_id', personId).maybeSingle();
                if (!mem && !god) return res.status(403).json({ success: false, message: 'You do not belong to this agency.' });
                const role = god ? 'owner' : (mem.role || 'admin');
                const canManage = god || role === 'admin' || (role === 'owner' && (mem.is_primary === true || mem.full_access === true));

                // ── White-label branding (owners/admins/god) ──
                if (action === 'get_agency_branding') {
                    const { data: full } = await supabase.from('partner_portals').select('*').eq('id', portal.id).maybeSingle();
                    const { data: dom } = await supabase.from('portal_brands').select('host, ssl_status, active').eq('portal_id', portal.id).eq('added_by_partner', true).maybeSingle();
                    const branding = {};
                    BRAND_FIELDS.forEach(f => { branding[f] = (full && full[f]) || ''; });
                    return res.status(200).json({
                        success: true, can_manage: canManage,
                        relationship_id: full.relationship_id, agency_name: full.agency_name || '',
                        agency_enabled: full.agency_enabled === true, domain: dom || null,
                        branding
                    });
                }
                if (action === 'save_agency_branding') {
                    if (!canManage) return res.status(403).json({ success: false, message: 'Only owners and admins can edit branding.' });
                    const b = body.branding || {};
                    const patch = { updated_at: new Date().toISOString() };
                    if (typeof body.agency_name === 'string') patch.agency_name = body.agency_name.trim() || null;
                    BRAND_FIELDS.forEach(f => { if (f in b) patch[f] = (b[f] || '').trim() || null; });
                    await supabase.from('partner_portals').update(patch).eq('id', portal.id);
                    await syncBrandingToDomains(portal.id, patch.agency_name);
                    return res.status(200).json({ success: true });
                }

                // ── Team & visibility grants (owners/admins) ──
                if (action === 'agency_team') {
                    const members = await loadMembers(portal.id);
                    const memberPids = new Set(members.map(m => m.person_id));
                    const candidates = (await agencySubAgents(portal.id)).filter(p => !memberPids.has(p.id));
                    const { data: subs } = await supabase.from('agency_sub_accounts').select('id, company_id, name').eq('portal_id', portal.id).order('created_at', { ascending: true });
                    return res.status(200).json({ success: true, can_manage: canManage, members, candidates, sub_accounts: (subs || []).map(s => ({ id: s.id, name: s.name, type: s.company_id ? 'company' : 'client' })) });
                }

                if (action === 'agency_grant') {
                    if (!canManage) return res.status(403).json({ success: false, message: 'Only owners and admins can grant access.' });
                    if (!body.member_person_id) return res.status(400).json({ success: false, message: 'member_person_id required.' });
                    // Don't touch owners via this flow.
                    const { data: ex } = await supabase.from('partner_portal_members').select('id, role').eq('portal_id', portal.id).eq('person_id', body.member_person_id).maybeSingle();
                    if (ex && ex.role === 'owner') return res.status(400).json({ success: false, message: 'That person is an owner already.' });
                    const grantRole = body.role === 'admin' ? 'admin' : 'sub_partner';
                    const scope = grantRole === 'sub_partner' ? { sub_account_ids: Array.isArray(body.sub_account_ids) ? body.sub_account_ids : [] } : {};
                    await supabase.from('partner_portal_members').upsert(
                        { portal_id: portal.id, person_id: body.member_person_id, role: grantRole, scope, added_by: personId },
                        { onConflict: 'portal_id,person_id' });
                    return res.status(200).json({ success: true, members: await loadMembers(portal.id) });
                }

                if (action === 'agency_set_scope') {
                    if (!canManage) return res.status(403).json({ success: false, message: 'Only owners and admins can change access.' });
                    const { data: m } = await supabase.from('partner_portal_members').select('*').eq('id', body.member_id).eq('portal_id', portal.id).maybeSingle();
                    if (!m) return res.status(404).json({ success: false, message: 'Member not found.' });
                    if (m.role === 'owner') return res.status(400).json({ success: false, message: 'Owners see everything.' });
                    await supabase.from('partner_portal_members').update({ scope: { sub_account_ids: Array.isArray(body.sub_account_ids) ? body.sub_account_ids : [] } }).eq('id', m.id);
                    return res.status(200).json({ success: true, members: await loadMembers(portal.id) });
                }

                if (action === 'agency_revoke') {
                    if (!canManage) return res.status(403).json({ success: false, message: 'Only owners and admins can revoke access.' });
                    const { data: m } = await supabase.from('partner_portal_members').select('role').eq('id', body.member_id).eq('portal_id', portal.id).maybeSingle();
                    if (!m) return res.status(200).json({ success: true, members: await loadMembers(portal.id) });
                    if (m.role === 'owner') return res.status(400).json({ success: false, message: 'Remove owners from the staff dashboard.' });
                    await supabase.from('partner_portal_members').delete().eq('id', body.member_id).eq('portal_id', portal.id);
                    return res.status(200).json({ success: true, members: await loadMembers(portal.id) });
                }

                if (action === 'my_companies') {
                    // The AGENCY's companies (its owners' book) not yet added as a sub-account.
                    const owned = await agencyCompanies(portal.id);
                    const { data: existing } = await supabase.from('agency_sub_accounts').select('company_id').eq('portal_id', portal.id).not('company_id', 'is', null);
                    const taken = new Set((existing || []).map(e => e.company_id));
                    const companies = Object.keys(owned).filter(cid => !taken.has(cid)).map(cid => ({ company_id: cid, company_name: owned[cid] }));
                    return res.status(200).json({ success: true, companies });
                }

                if (action === 'list_sub_accounts') {
                    const { data: subs } = await supabase.from('agency_sub_accounts').select('id, company_id, name, status, created_at').eq('portal_id', portal.id).order('created_at', { ascending: true });
                    return res.status(200).json({ success: true, can_manage: canManage, sub_accounts: (subs || []).map(s => ({ ...s, type: s.company_id ? 'company' : 'client' })) });
                }

                if (action === 'create_sub_account') {
                    if (!canManage) return res.status(403).json({ success: false, message: 'Only owners and admins can create sub-accounts.' });
                    const companyId = body.company_id || null;
                    let name = (body.name || '').trim();
                    if (companyId) {
                        // Linking a company — must be one of the agency's (owners') companies.
                        const agComps = await agencyCompanies(portal.id);
                        if (!agComps[companyId]) return res.status(400).json({ success: false, message: 'That company is not part of this agency.' });
                        if (!name) name = agComps[companyId];
                        const { data: dup } = await supabase.from('agency_sub_accounts').select('id').eq('portal_id', portal.id).eq('company_id', companyId).maybeSingle();
                        if (dup) return res.status(409).json({ success: false, message: 'That company is already a sub-account here.' });
                    } else {
                        if (!name) return res.status(400).json({ success: false, message: 'Enter a name for the sub-account.' });
                    }
                    const { data: created, error } = await supabase.from('agency_sub_accounts')
                        .insert({ portal_id: portal.id, company_id: companyId, name, created_by: personId })
                        .select('id, company_id, name, status').single();
                    if (error) return res.status(500).json({ success: false, message: 'Could not create sub-account.' });
                    return res.status(200).json({ success: true, sub_account: { ...created, type: created.company_id ? 'company' : 'client' } });
                }

                if (action === 'delete_sub_account') {
                    if (!canManage) return res.status(403).json({ success: false, message: 'Only owners and admins can remove sub-accounts.' });
                    await supabase.from('agency_sub_accounts').delete().eq('id', body.sub_account_id).eq('portal_id', portal.id);
                    return res.status(200).json({ success: true });
                }
            }

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
                // Resolve the agency by portal_id (god/any managed agency) or the person's own.
                const god = await isGod(personId);
                let portal = body.portal_id
                    ? (await supabase.from('partner_portals').select('*').eq('id', body.portal_id).maybeSingle()).data
                    : await getPortal(personId);
                if (!portal) return res.status(404).json({ success: false, message: 'Agency not found.' });
                if (!god) {
                    const { data: mem } = await supabase.from('partner_portal_members').select('role, is_primary, full_access').eq('portal_id', portal.id).eq('person_id', personId).maybeSingle();
                    const canManage = mem && (mem.role === 'admin' || (mem.role === 'owner' && (mem.is_primary === true || mem.full_access === true)));
                    if (!canManage) return res.status(403).json({ success: false, message: 'Only owners and admins can rename the agency.' });
                }
                await supabase.from('partner_portals').update({ agency_name: (body.agency_name || '').trim() || null, updated_at: new Date().toISOString() }).eq('id', portal.id);
                return res.status(200).json({ success: true, agency_name: (body.agency_name || '').trim() || null });
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
                // Seed the new domain with the agency's existing branding.
                BRAND_FIELDS.forEach(f => { row[f] = portal[f] || null; });
                if (taken) await supabase.from('portal_brands').update(row).eq('id', taken.id);
                else await supabase.from('portal_brands').upsert(row, { onConflict: 'host' });
                // Auto-register the domain with Vercel so it serves the host (best-effort).
                let vercel = null;
                try { const vr = await vercelAddDomain(host); if (!vr.skipped) vercel = vr.ok ? 'added' : 'error'; } catch (e) {}
                return res.status(200).json({ success: true, host, cname_target: cf.target, status: d.phase, verification: row.verification, vercel });
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
                try { await vercelRemoveDomain(brand.host); } catch (e) {}
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
            const v = await getVercelConfig();
            return res.status(200).json({
                success: true,
                configured: cfConfigured(cf),
                zone_set: !!cf.zone, token_set: !!cf.token,
                cname_target: cf.target || '',
                vercel_configured: vercelConfigured(v), vercel_token_set: !!v.token,
                vercel_project: v.project || '', vercel_team: v.team || ''
            });
        }
        if (action === 'cf_config_set') {
            const c = body.config || {};
            if (typeof c.token === 'string' && c.token && !/^\*+$/.test(c.token)) await setConfigValue('CF_API_TOKEN', c.token.trim(), actor.userid || 'admin');
            if (typeof c.zone === 'string') await setConfigValue('CF_ZONE_ID', c.zone.trim(), actor.userid || 'admin');
            if (typeof c.target === 'string') await setConfigValue('CF_CNAME_TARGET', normHost(c.target), actor.userid || 'admin');
            // Vercel (optional) — auto-registers partner domains with the Vercel project.
            if (typeof c.vercel_token === 'string' && c.vercel_token && !/^\*+$/.test(c.vercel_token)) await setConfigValue('VERCEL_TOKEN', c.vercel_token.trim(), actor.userid || 'admin');
            if (typeof c.vercel_project === 'string') await setConfigValue('VERCEL_PROJECT_ID', c.vercel_project.trim(), actor.userid || 'admin');
            if (typeof c.vercel_team === 'string') await setConfigValue('VERCEL_TEAM_ID', c.vercel_team.trim(), actor.userid || 'admin');
            const cf = await getCfConfig();
            return res.status(200).json({ success: true, configured: cfConfigured(cf), cname_target: cf.target || '' });
        }

        // Live Cloudflare-for-SaaS diagnostics: is the Fallback Origin configured & active,
        // and what does CF say about each custom hostname (status, SSL, validation errors)?
        if (action === 'cf_diagnostics') {
            const cf = await getCfConfig();
            if (!cfConfigured(cf)) return res.status(200).json({ success: true, configured: false });
            const fo = await cfFetch(cf, `/zones/${cf.zone}/custom_hostnames/fallback_origin`, { method: 'GET' });
            const list = await cfFetch(cf, `/zones/${cf.zone}/custom_hostnames?per_page=50`, { method: 'GET' });
            const foRes = (fo.json && fo.json.result) || null;
            // If listing custom hostnames fails auth, the token/zone pair is wrong — that's
            // a different (and more fundamental) problem than "no fallback origin."
            const authBad = !list.ok && [400, 401, 403].indexOf(list.status) >= 0;
            const authMsg = authBad ? ((list.json && list.json.errors && list.json.errors[0] && list.json.errors[0].message) || ('HTTP ' + list.status)) : null;
            const hostnames = ((list.json && list.json.result) || []).map(h => ({
                hostname: h.hostname, status: h.status,
                ssl_status: h.ssl && h.ssl.status, ssl_method: h.ssl && h.ssl.method,
                ssl_errors: (h.ssl && h.ssl.validation_errors || []).map(e => e.message),
                verification_errors: h.verification_errors || []
            }));
            return res.status(200).json({
                success: true, configured: true, cname_target: cf.target || '',
                auth_error: authMsg,
                fallback_origin: foRes ? { origin: foRes.origin, status: foRes.status, errors: foRes.errors || [] } : null,
                fallback_error: fo.ok ? null : ((fo.json && fo.json.errors && fo.json.errors[0] && fo.json.errors[0].message) || 'not set'),
                hostnames
            });
        }

        // Grant / revoke a partner's white-label agency access (staff, per-partner).
        if (action === 'set_agency_access') {
            const personId = body.person_id;
            if (!personId) return res.status(400).json({ success: false, message: 'person_id required.' });
            const enabled = body.enabled === true || body.enabled === 'true';
            // Rule: only BRANDED partners can be white-labeled agency owners.
            if (enabled) {
                const { data: pr } = await supabase.from('persons').select('is_branded').eq('id', personId).maybeSingle();
                if (!pr || pr.is_branded !== true) {
                    return res.status(400).json({ success: false, message: 'Mark this partner as a Branded partner before granting white-label agency access.', need_branded: true });
                }
            }
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

        // Staff/god-mode: set an agency's name (resolves by person_id or portal_id).
        if (action === 'admin_set_agency_name') {
            const portal = await resolvePortal(body);
            if (!portal) return res.status(404).json({ success: false, message: 'Agency not found.' });
            await supabase.from('partner_portals').update({ agency_name: (body.agency_name || '').trim() || null, updated_at: new Date().toISOString() }).eq('id', portal.id);
            return res.status(200).json({ success: true, agency_name: (body.agency_name || '').trim() || null });
        }

        // Read a partner's agency status (staff — used by the partners dashboard toggle).
        if (action === 'get_agency_access') {
            const personId = body.person_id;
            if (!personId) return res.status(400).json({ success: false, message: 'person_id required.' });
            const { data: pbr } = await supabase.from('persons').select('is_branded').eq('id', personId).maybeSingle();
            const isBranded = !!(pbr && pbr.is_branded);
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
                is_branded: isBranded,
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
