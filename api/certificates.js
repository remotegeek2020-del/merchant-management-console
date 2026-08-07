import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { getPartnerTiers } from './partner-portal.js';

export const config = { api: { bodyParser: { sizeLimit: '3mb' } } };

// ── default design ───────────────────────────────────────────────────────────
const DEFAULT_COLORS = { bg: '#fffdf7', ink: '#2a2313', body: '#4a4230', accent: '#b98a2e', accent2: '#e3c163', muted: '#8a7c58' };
const DEFAULT_DESIGN = {
    id: 'partnership',
    name: 'Partnership Certificate',
    is_default: true,
    template: 'classic',
    heading_font: 'Playfair Display',
    body_font: 'DM Sans',
    colors: DEFAULT_COLORS,
    logo_url: '',
    org_name: 'PayProTec',
    partner_title: 'Certified Partner',
    name_placeholder: 'Partner Name',
    heading: 'Certificate of Partnership',
    pre_text: 'This certifies that',
    body_text: 'has successfully graduated and is hereby recognized as a',
    signatories: [],
    partner_logos: [],
    partner_logos_label: 'In partnership with'
};

function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'cert'; }
function genId(name) { return slug(name) + '-' + Math.random().toString(36).slice(2, 7); }
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function cleanArr(a, mapper, max) {
    return (Array.isArray(a) ? a : []).map(mapper).filter(Boolean).slice(0, max);
}

// Normalize an arbitrary object into a valid design.
function loadDesign(raw) {
    const c = (raw && typeof raw === 'object') ? raw : {};
    const colors = Object.assign({}, DEFAULT_COLORS);
    if (c.colors && typeof c.colors === 'object') {
        ['bg', 'ink', 'body', 'accent', 'accent2', 'muted'].forEach(k => { if (HEX.test(c.colors[k] || '')) colors[k] = c.colors[k]; });
    }
    return {
        id: String(c.id || '').trim() || genId(c.name || 'cert'),
        name: String(c.name || 'Certificate').slice(0, 80),
        is_default: !!c.is_default,
        template: String(c.template || 'classic').slice(0, 40),
        heading_font: String(c.heading_font || 'Playfair Display').slice(0, 60),
        body_font: String(c.body_font || 'DM Sans').slice(0, 60),
        colors,
        logo_url: String(c.logo_url || '').slice(0, 600),
        org_name: String(c.org_name || 'PayProTec').slice(0, 120),
        partner_title: String(c.partner_title || 'Certified Partner').slice(0, 120),
        name_placeholder: String(c.name_placeholder || 'Partner Name').slice(0, 120),
        heading: String(c.heading || 'Certificate of Partnership').slice(0, 120),
        pre_text: String(c.pre_text || 'This certifies that').slice(0, 160),
        body_text: String(c.body_text || DEFAULT_DESIGN.body_text).slice(0, 400),
        signatories: cleanArr(c.signatories, s => (s && (s.name || s.title || s.image_url)) ? {
            name: String(s.name || '').slice(0, 120), title: String(s.title || '').slice(0, 120), image_url: String(s.image_url || '').slice(0, 600)
        } : null, 5),
        partner_logos: cleanArr(c.partner_logos, x => (x && x.url) ? {
            url: String(x.url).slice(0, 600), name: String(x.name || '').slice(0, 120)
        } : null, 14),
        partner_logos_label: String(c.partner_logos_label || 'In partnership with').slice(0, 80)
    };
}

async function getDesigns(supabase) {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'cert_designs').maybeSingle();
    let arr = null;
    if (data && data.value) { try { arr = JSON.parse(data.value); } catch (e) { arr = null; } }
    if (!Array.isArray(arr) || !arr.length) {
        // One-time migration from the legacy single-config key.
        const { data: legacy } = await supabase.from('app_settings').select('value').eq('key', 'cert_config').maybeSingle();
        if (legacy && legacy.value) {
            let lc = {}; try { lc = JSON.parse(legacy.value); } catch (e) { lc = {}; }
            arr = [Object.assign({}, DEFAULT_DESIGN, lc, { id: 'partnership', is_default: true, name: 'Partnership Certificate' })];
        } else {
            arr = [Object.assign({}, DEFAULT_DESIGN)];
        }
    }
    const designs = arr.map(loadDesign);
    // Guarantee exactly one default.
    if (!designs.some(d => d.is_default)) designs[0].is_default = true;
    let seenDefault = false;
    designs.forEach(d => { if (d.is_default) { if (seenDefault) d.is_default = false; else seenDefault = true; } });
    return designs;
}

function defaultDesign(designs) { return designs.find(d => d.is_default) || designs[0] || loadDesign(DEFAULT_DESIGN); }
function findDesign(designs, typeId) { return designs.find(d => d.id === typeId) || defaultDesign(designs); }

// Merge a certificate row + its design into the render payload.
function renderData(cert, design) {
    return {
        template: design.template,
        colors: design.colors,
        body_font: design.body_font,
        heading_font: design.heading_font,
        org_name: design.org_name,
        logo_url: design.logo_url,
        heading: design.heading,
        pre_text: design.pre_text,
        body_text: design.body_text,
        signatories: design.signatories,
        partner_logos: design.partner_logos,
        partner_logos_label: design.partner_logos_label,
        partner_title: cert.partner_title || design.partner_title,
        recipient_name: cert.recipient_name,
        company_name: cert.company_name || '',
        cert_number: cert.cert_number,
        issued_date: cert.issued_date,
        type_id: cert.type_id,
        type_name: cert.type_name || design.name,
        id: cert.id
    };
}

// Distinct companies a partner belongs to (via their agents). "Independent"
// (an agent with no company) counts as one company. Returns [{company_id, company_name}].
async function getPartnerCompanies(supabase, personId) {
    const { data: agents } = await supabase.from('agents')
        .select('company_id, companies:company_id(company_name)').eq('parent_agent_id', personId);
    const map = {};
    (agents || []).forEach(a => {
        const cid = a.company_id || null;
        const cname = (a.companies && a.companies.company_name) || 'Independent';
        const key = cid ? String(cid) : ('name:' + cname);
        if (!map[key]) map[key] = { company_id: cid, company_name: cname };
    });
    return Object.keys(map).map(k => map[k]);
}
function companyKey(cid, cname) { return cid ? String(cid) : ('name:' + (cname || '')); }

/**
 * Issue (or return the existing) certificate of a given type for a partner.
 * typeId defaults to the default design. Best-effort caller should try/catch.
 */
export async function issueCertificate(supabase, opts) {
    const personId = opts && opts.personId;
    if (!personId) return { ok: false, error: 'personId required' };
    const designs = await getDesigns(supabase);
    const design = opts.typeId ? findDesign(designs, opts.typeId) : defaultDesign(designs);
    const companyId = opts.companyId || null;
    const companyName = opts.companyName || null;

    const findExisting = () => {
        let q = supabase.from('partner_certificates').select('*').eq('person_id', personId).eq('type_id', design.id);
        if (companyId) q = q.eq('company_id', companyId);
        else { q = q.is('company_id', null); q = companyName ? q.eq('company_name', companyName) : q.is('company_name', null); }
        return q.maybeSingle();
    };
    const { data: existing } = await findExisting();
    if (existing) return { ok: true, certificate: existing, created: false, design };

    let name = opts.recipientName;
    if (!name) {
        const { data: p } = await supabase.from('persons').select('full_name').eq('id', personId).maybeSingle();
        name = (p && p.full_name) || 'Partner';
    }
    let certNo = '';
    try { const { data: n } = await supabase.rpc('next_partner_cert_number'); certNo = n; } catch (e) { certNo = 'PPT-' + Date.now(); }

    const row = {
        person_id: personId, type_id: design.id, type_name: design.name,
        cert_number: certNo, recipient_name: name, partner_title: design.partner_title,
        template: design.template, config_snapshot: design, source: opts.source || 'graduation',
        company_id: companyId, company_name: companyName
    };
    if (opts.issuedDate) row.issued_date = opts.issuedDate;

    const { data: created, error } = await supabase.from('partner_certificates').insert(row).select('*').single();
    if (error) {
        const { data: again } = await findExisting();
        if (again) return { ok: true, certificate: again, created: false, design };
        return { ok: false, error: error.message };
    }
    return { ok: true, certificate: created, created: true, design };
}

/**
 * Issue the default (partnership) certificate ONCE PER COMPANY the partner belongs to.
 * A partner with 4 companies gets 4 certificates; Independent + a company => 2.
 * Self-healing: adopts a legacy company-less certificate into the first company so
 * existing partners don't end up with a duplicate blank certificate.
 */
export async function issuePartnershipCerts(supabase, personId, opts) {
    opts = opts || {};
    const designs = await getDesigns(supabase);
    const def = defaultDesign(designs);
    const companies = await getPartnerCompanies(supabase, personId);
    let name = opts.recipientName;
    if (!name) {
        const { data: p } = await supabase.from('persons').select('full_name').eq('id', personId).maybeSingle();
        name = (p && p.full_name) || 'Partner';
    }
    let { data: existing } = await supabase.from('partner_certificates').select('*').eq('person_id', personId).eq('type_id', def.id);
    existing = existing || [];

    if (!companies.length) {
        if (!existing.length) {
            const r = await issueCertificate(supabase, { personId, typeId: def.id, recipientName: name, source: opts.source, issuedDate: opts.issuedDate });
            return r.ok ? [r.certificate] : [];
        }
        return existing;
    }

    const covered = {};
    existing.forEach(c => { covered[companyKey(c.company_id, c.company_name)] = c; });
    // Adopt any company-less legacy certs into uncovered companies (reuse their number).
    const legacy = existing.filter(c => !c.company_id && (!c.company_name || c.company_name === ''));
    let li = 0;
    for (const co of companies) {
        if (covered[companyKey(co.company_id, co.company_name)]) continue;
        if (li < legacy.length) {
            const row = legacy[li++];
            await supabase.from('partner_certificates').update({ company_id: co.company_id || null, company_name: co.company_name || null }).eq('id', row.id);
            covered[companyKey(co.company_id, co.company_name)] = row;
        }
    }
    // Issue any still-uncovered companies.
    for (const co of companies) {
        if (covered[companyKey(co.company_id, co.company_name)]) continue;
        await issueCertificate(supabase, { personId, typeId: def.id, recipientName: name, source: opts.source, issuedDate: opts.issuedDate, companyId: co.company_id, companyName: co.company_name });
    }
    const { data: final } = await supabase.from('partner_certificates').select('*').eq('person_id', personId).eq('type_id', def.id).order('created_at', { ascending: true });
    return final || [];
}

// ── AWARD AUTOMATION ─────────────────────────────────────────────────────────
// Rules live in app_settings key 'partner_award_rules' (JSON array). Each rule:
//   { id, enabled, metric, value, tier, type_id, label }
// metric ∈ 'approved' | 'pos_leads' | 'volume_30' | 'rank' | 'tier'
const AWARD_METRICS = ['approved', 'pos_leads', 'volume_30', 'rank', 'tier'];

async function getAwardRules(supabase) {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'partner_award_rules').maybeSingle();
    let arr = []; try { arr = JSON.parse(data?.value || '[]'); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    return arr.map(r => ({
        id: String(r.id || '') || ('rule-' + Math.random().toString(36).slice(2, 8)),
        enabled: r.enabled !== false,
        metric: AWARD_METRICS.indexOf(r.metric) >= 0 ? r.metric : 'approved',
        value: Number(r.value) || 0,
        tier: ['Gold', 'Silver', 'Bronze'].indexOf(r.tier) >= 0 ? r.tier : 'Gold',
        type_id: String(r.type_id || ''),
        label: String(r.label || '').slice(0, 120)
    })).filter(r => r.type_id);
}

// Count POS Express leads per partner (person_id), paginated to beat the 1k cap.
async function posCountsByPartner(supabase) {
    const counts = {}; let from = 0; const page = 1000;
    for (;;) {
        const { data, error } = await supabase.from('pos_leads').select('partner_id').range(from, from + page - 1);
        if (error || !data || !data.length) break;
        data.forEach(r => { if (r.partner_id) counts[r.partner_id] = (counts[r.partner_id] || 0) + 1; });
        if (data.length < page) break;
        from += page;
    }
    return counts;
}

function ruleMet(rule, m) {
    if (!m) return false;
    switch (rule.metric) {
        case 'approved': return (m.approved || 0) >= rule.value;
        case 'pos_leads': return (m.pos_leads || 0) >= rule.value;
        case 'volume_30': return (m.vol30 || 0) >= rule.value;
        case 'rank': return m.rank && m.rank <= rule.value;
        case 'tier': return m.tier === rule.tier;
        default: return false;
    }
}

/**
 * Scan all partners and auto-award certificates for every enabled rule they meet.
 * Idempotent (issueCertificate never double-issues). Returns a summary.
 */
export async function runAwardAutomation(supabase) {
    const rules = (await getAwardRules(supabase)).filter(r => r.enabled);
    if (!rules.length) return { ran: true, rules: 0, issued: 0, scanned: 0, per_rule: [] };

    const needsPortfolio = rules.some(r => ['approved', 'volume_30', 'rank', 'tier'].indexOf(r.metric) >= 0);
    const needsPos = rules.some(r => r.metric === 'pos_leads');
    const needsTier = rules.some(r => r.metric === 'tier');

    const metrics = {}; // person_id -> {approved, vol30, rank, tier, pos_leads, name}

    if (needsPortfolio) {
        // Refresh the leaderboard so numbers are current, then read it (ranked by 30d volume).
        try { await supabase.rpc('refresh_leaderboard_mv'); } catch (e) { /* view may auto-refresh */ }
        const { data: rows } = await supabase.from('partner_leaderboard_mv')
            .select('person_id, name, merchant_count, volume_30_day, volume_90_day')
            .order('volume_30_day', { ascending: false });
        const tiers = needsTier ? await getPartnerTiers(supabase) : { gold: 3, silver: 10 };
        (rows || []).forEach((r, i) => {
            const rank = i + 1;
            metrics[r.person_id] = {
                name: r.name,
                approved: parseInt(r.merchant_count || 0, 10),
                vol30: parseFloat(r.volume_30_day || 0),
                rank,
                tier: rank <= tiers.gold ? 'Gold' : rank <= tiers.silver ? 'Silver' : 'Bronze'
            };
        });
    }
    if (needsPos) {
        const pos = await posCountsByPartner(supabase);
        Object.keys(pos).forEach(pid => {
            if (!metrics[pid]) metrics[pid] = {};
            metrics[pid].pos_leads = pos[pid];
        });
    }

    // Names for any person we might award but didn't get from the leaderboard.
    const missing = Object.keys(metrics).filter(pid => !metrics[pid].name);
    if (missing.length) {
        for (let i = 0; i < missing.length; i += 300) {
            const chunk = missing.slice(i, i + 300);
            const { data } = await supabase.from('persons').select('id, full_name').in('id', chunk);
            (data || []).forEach(p => { if (metrics[p.id]) metrics[p.id].name = p.full_name; });
        }
    }

    let issued = 0;
    const perRule = rules.map(r => ({ id: r.id, label: r.label, metric: r.metric, value: r.value, tier: r.tier, type_id: r.type_id, awarded: 0 }));
    const ids = Object.keys(metrics);
    for (const pid of ids) {
        const m = metrics[pid];
        for (let ri = 0; ri < rules.length; ri++) {
            const rule = rules[ri];
            if (!ruleMet(rule, m)) continue;
            try {
                const res = await issueCertificate(supabase, { personId: pid, typeId: rule.type_id, recipientName: m.name, source: 'auto' });
                if (res.ok && res.created) { issued++; perRule[ri].awarded++; }
            } catch (e) { /* keep scanning */ }
        }
    }
    return { ran: true, rules: rules.length, scanned: ids.length, issued, per_rule: perRule };
}

const PARTNER_ACTIONS = new Set(['my_certificates']);

async function validatePartner(supabase, token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const body = req.body || {};
    const action = body.action || (req.method === 'GET' ? 'get_designs' : null);

    try {
        // ── PARTNER: my certificates ────────────────────────────────────────
        if (PARTNER_ACTIONS.has(action)) {
            const personId = await validatePartner(supabase, body.token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });

            const { data: person } = await supabase.from('persons').select('id, full_name, enrolled_at').eq('id', personId).maybeSingle();
            const designs = await getDesigns(supabase);

            // Ensure the default (partnership) certificate exists — one per company.
            await issuePartnershipCerts(supabase, personId, {
                recipientName: person && person.full_name, source: 'auto',
                issuedDate: person && person.enrolled_at ? String(person.enrolled_at).slice(0, 10) : undefined
            });
            let { data: certs } = await supabase.from('partner_certificates').select('*').eq('person_id', personId).order('created_at', { ascending: true });
            certs = certs || [];
            const out = certs.map(c => {
                // Use the live design; if its design was deleted, fall back to the snapshot.
                let design = designs.find(d => d.id === c.type_id);
                if (!design) design = loadDesign(c.config_snapshot || {});
                return renderData(c, design);
            });
            return res.status(200).json({ success: true, certificates: out });
        }

        // ── STAFF (Bearer session) ──────────────────────────────────────────
        const session = await validateSession(req);
        if (!session) return sessionErrorResponse(res);

        if (action === 'get_designs') {
            const designs = await getDesigns(supabase);
            return res.status(200).json({ success: true, designs });
        }

        if (action === 'upload_url') {
            const ft = String(body.file_type || '');
            const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
            const ext = EXT[ft];
            if (!ext) return res.status(400).json({ success: false, message: 'Only PNG, JPG, WEBP, GIF or SVG images are allowed.' });
            const path = `cert-assets/${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`;
            const { data, error } = await supabase.storage.from('marketing').createSignedUploadUrl(path);
            if (error) return res.status(500).json({ success: false, message: error.message });
            const public_url = `${process.env.SUPABASE_URL}/storage/v1/object/public/marketing/${path}`;
            return res.status(200).json({ success: true, upload_url: data.signedUrl, public_url, path });
        }

        if (action === 'save_designs') {
            const { data: caller } = await supabase.from('app_users')
                .select('role, is_active, first_name, last_name, email').eq('userid', session.userid).maybeSingle();
            if (!caller?.is_active || caller.role !== 'super_admin') {
                return res.status(403).json({ success: false, message: 'Super admin only.' });
            }
            let designs = (Array.isArray(body.designs) ? body.designs : []).map(loadDesign);
            if (!designs.length) designs = [Object.assign({}, DEFAULT_DESIGN)];
            // Ensure unique ids.
            const seen = {};
            designs.forEach(d => { if (seen[d.id]) d.id = genId(d.name); seen[d.id] = true; });
            // Exactly one default.
            if (!designs.some(d => d.is_default)) designs[0].is_default = true;
            let sd = false; designs.forEach(d => { if (d.is_default) { if (sd) d.is_default = false; else sd = true; } });

            const actorName = `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || caller.email;
            const { error } = await supabase.from('app_settings').upsert({
                key: 'cert_designs', value: JSON.stringify(designs), updated_at: new Date().toISOString(), updated_by: actorName
            }, { onConflict: 'key' });
            if (error) throw error;
            supabase.from('activity_logs').insert({
                email: caller.email || session.userid, action: `Certificate designs updated by ${actorName}`,
                status: 'success', category: 'admin', target_type: 'app_setting', target_id: 'cert_designs', severity: 'info'
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true, designs });
        }

        // ── Award: search partners ──────────────────────────────────────────
        if (action === 'search_partners') {
            const q = String(body.query || '').replace(/[%,()]/g, ' ').trim();
            if (q.length < 2) return res.status(200).json({ success: true, partners: [] });
            const { data } = await supabase.from('persons')
                .select('id, full_name, email').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(12);
            return res.status(200).json({ success: true, partners: data || [] });
        }

        // ── Award: a partner's companies + current certificates ─────────────
        if (action === 'person_certs') {
            if (!body.person_id) return res.status(400).json({ success: false, message: 'person_id required' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email').eq('id', body.person_id).maybeSingle();
            if (!person) return res.status(404).json({ success: false, message: 'Partner not found' });
            const designs = await getDesigns(supabase);
            const companies = await getPartnerCompanies(supabase, body.person_id);
            const { data: rows } = await supabase.from('partner_certificates').select('*').eq('person_id', body.person_id).order('created_at', { ascending: true });
            const certs = (rows || []).map(c => {
                let design = designs.find(d => d.id === c.type_id) || loadDesign(c.config_snapshot || {});
                return renderData(c, design);
            });
            return res.status(200).json({ success: true, person, companies, certs });
        }

        // ── Award: issue a certificate to a partner (super_admin) ───────────
        if (action === 'award') {
            const { data: caller } = await supabase.from('app_users').select('role, is_active, email').eq('userid', session.userid).maybeSingle();
            if (!caller?.is_active || caller.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super admin only.' });
            if (!body.person_id || !body.type_id) return res.status(400).json({ success: false, message: 'person_id and type_id required' });
            const { data: person } = await supabase.from('persons').select('id, full_name').eq('id', body.person_id).maybeSingle();
            if (!person) return res.status(404).json({ success: false, message: 'Partner not found' });
            const r = await issueCertificate(supabase, {
                personId: body.person_id, typeId: body.type_id, recipientName: person.full_name,
                companyId: body.company_id || null, companyName: body.company_name || null, source: 'awarded'
            });
            if (!r.ok) return res.status(500).json({ success: false, message: r.error || 'Could not award certificate.' });
            supabase.from('activity_logs').insert({
                email: caller.email || session.userid, action: `Awarded certificate "${r.design.name}" to ${person.full_name}`,
                status: 'success', category: 'admin', target_type: 'certificate', target_id: r.certificate.id, severity: 'info'
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true, created: r.created, certificate: renderData(r.certificate, r.design) });
        }

        // ── Award: revoke an issued certificate (super_admin) ───────────────
        if (action === 'revoke') {
            const { data: caller } = await supabase.from('app_users').select('role, is_active, email').eq('userid', session.userid).maybeSingle();
            if (!caller?.is_active || caller.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super admin only.' });
            if (!body.cert_id) return res.status(400).json({ success: false, message: 'cert_id required' });
            const { error } = await supabase.from('partner_certificates').delete().eq('id', body.cert_id);
            if (error) return res.status(500).json({ success: false, message: error.message });
            supabase.from('activity_logs').insert({
                email: caller.email || session.userid, action: `Revoked a certificate`,
                status: 'success', category: 'admin', target_type: 'certificate', target_id: body.cert_id, severity: 'warning'
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true });
        }

        // ── Award: BULK award one design to many partners (super_admin) ─────
        if (action === 'award_bulk') {
            const { data: caller } = await supabase.from('app_users').select('role, is_active, email').eq('userid', session.userid).maybeSingle();
            if (!caller?.is_active || caller.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super admin only.' });
            const ids = Array.isArray(body.person_ids) ? body.person_ids.filter(Boolean).slice(0, 1000) : [];
            if (!ids.length || !body.type_id) return res.status(400).json({ success: false, message: 'person_ids and type_id required' });
            // Prefetch names in chunks.
            const names = {};
            for (let i = 0; i < ids.length; i += 300) {
                const { data } = await supabase.from('persons').select('id, full_name').in('id', ids.slice(i, i + 300));
                (data || []).forEach(p => { names[p.id] = p.full_name; });
            }
            let awarded = 0, already = 0, failed = 0;
            for (const pid of ids) {
                try {
                    const r = await issueCertificate(supabase, { personId: pid, typeId: body.type_id, recipientName: names[pid], source: 'awarded' });
                    if (r.ok) { r.created ? awarded++ : already++; } else failed++;
                } catch (e) { failed++; }
            }
            supabase.from('activity_logs').insert({
                email: caller.email || session.userid, action: `Bulk-awarded a certificate to ${awarded} partner(s)`,
                status: 'success', category: 'admin', target_type: 'certificate', target_id: body.type_id, severity: 'info'
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true, awarded, already, failed });
        }

        // ── Awardees list: summary by design, or paginated list for one type ─
        if (action === 'list_awarded') {
            if (body.type_id) {
                const limit = Math.min(parseInt(body.limit, 10) || 25, 100);
                const offset = parseInt(body.offset, 10) || 0;
                const { data, count } = await supabase.from('partner_certificates')
                    .select('id, recipient_name, company_name, cert_number, issued_date, source, person_id', { count: 'exact' })
                    .eq('type_id', body.type_id).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
                return res.status(200).json({ success: true, rows: data || [], total: count || 0, offset, limit });
            }
            const { data, error } = await supabase.rpc('partner_certificate_counts');
            if (error) return res.status(500).json({ success: false, message: error.message });
            return res.status(200).json({ success: true, groups: (data || []).map(g => ({ type_id: g.type_id, type_name: g.type_name, count: Number(g.cnt) })) });
        }

        // ── Award automation rules: get / save / run ────────────────────────
        if (action === 'get_award_rules') {
            const rules = await getAwardRules(supabase);
            const designs = await getDesigns(supabase);
            return res.status(200).json({ success: true, rules, designs: designs.map(d => ({ id: d.id, name: d.name })) });
        }
        if (action === 'save_award_rules') {
            const { data: caller } = await supabase.from('app_users').select('role, is_active, first_name, last_name, email').eq('userid', session.userid).maybeSingle();
            if (!caller?.is_active || caller.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super admin only.' });
            const clean = (Array.isArray(body.rules) ? body.rules : []).map(r => ({
                id: String(r.id || '') || ('rule-' + Date.now() + '-' + Math.floor(Math.random() * 1e4)),
                enabled: r.enabled !== false,
                metric: AWARD_METRICS.indexOf(r.metric) >= 0 ? r.metric : 'approved',
                value: Number(r.value) || 0,
                tier: ['Gold', 'Silver', 'Bronze'].indexOf(r.tier) >= 0 ? r.tier : 'Gold',
                type_id: String(r.type_id || ''),
                label: String(r.label || '').slice(0, 120)
            })).filter(r => r.type_id);
            const who = `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || caller.email;
            const { error } = await supabase.from('app_settings').upsert({ key: 'partner_award_rules', value: JSON.stringify(clean), updated_at: new Date().toISOString(), updated_by: who }, { onConflict: 'key' });
            if (error) throw error;
            return res.status(200).json({ success: true, rules: clean });
        }
        if (action === 'run_award_automation') {
            const { data: caller } = await supabase.from('app_users').select('role, is_active, email').eq('userid', session.userid).maybeSingle();
            if (!caller?.is_active || caller.role !== 'super_admin') return res.status(403).json({ success: false, message: 'Super admin only.' });
            const summary = await runAwardAutomation(supabase);
            supabase.from('activity_logs').insert({
                email: caller.email || session.userid, action: `Ran certificate automation — ${summary.issued} awarded`,
                status: 'success', category: 'admin', target_type: 'certificate', target_id: 'automation', severity: 'info'
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true, summary });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[certificates]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
}
