import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

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
        cert_number: cert.cert_number,
        issued_date: cert.issued_date,
        type_id: cert.type_id,
        type_name: cert.type_name || design.name,
        id: cert.id
    };
}

/**
 * Issue (or return the existing) certificate of a given type for a partner.
 * typeId defaults to the default design. Best-effort caller should try/catch.
 */
export async function issueCertificate(supabase, opts) {
    const personId = opts && opts.personId;
    if (!personId) return { ok: false, error: 'personId required' };
    const designs = await getDesigns(supabase);
    const design = opts.typeId ? findDesign(designs, opts.typeId) : defaultDesign(designs);

    const { data: existing } = await supabase.from('partner_certificates').select('*').eq('person_id', personId).eq('type_id', design.id).maybeSingle();
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
        template: design.template, config_snapshot: design, source: opts.source || 'graduation'
    };
    if (opts.issuedDate) row.issued_date = opts.issuedDate;

    const { data: created, error } = await supabase.from('partner_certificates').insert(row).select('*').single();
    if (error) {
        const { data: again } = await supabase.from('partner_certificates').select('*').eq('person_id', personId).eq('type_id', design.id).maybeSingle();
        if (again) return { ok: true, certificate: again, created: false, design };
        return { ok: false, error: error.message };
    }
    return { ok: true, certificate: created, created: true, design };
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
            const def = defaultDesign(designs);

            // Ensure the default (partnership) certificate exists.
            let { data: certs } = await supabase.from('partner_certificates').select('*').eq('person_id', personId).order('created_at', { ascending: true });
            certs = certs || [];
            if (!certs.some(c => c.type_id === def.id)) {
                const iss = await issueCertificate(supabase, {
                    personId, typeId: def.id, recipientName: person && person.full_name, source: 'auto',
                    issuedDate: person && person.enrolled_at ? String(person.enrolled_at).slice(0, 10) : undefined
                });
                if (iss.ok && iss.certificate) certs.push(iss.certificate);
            }
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

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[certificates]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
}
