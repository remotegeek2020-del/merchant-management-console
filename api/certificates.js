import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

// ── default certificate configuration ────────────────────────────────────────
const DEFAULT_CONFIG = {
    template: 'classic',
    logo_url: '',
    org_name: 'PayProTec',
    partner_title: 'Certified Partner',
    name_placeholder: 'Partner Name',
    body_text: 'has successfully graduated and is hereby recognized as a',
    signatories: []
};

function loadConfig(raw) {
    let c = {};
    try { c = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch (e) { c = {}; }
    const cfg = Object.assign({}, DEFAULT_CONFIG, c || {});
    cfg.signatories = (Array.isArray(cfg.signatories) ? cfg.signatories : [])
        .map(s => ({ name: String(s.name || '').slice(0, 120), title: String(s.title || '').slice(0, 120), image_url: String(s.image_url || '').slice(0, 600) }))
        .filter(s => s.name || s.title || s.image_url)
        .slice(0, 5);
    return cfg;
}

async function getConfig(supabase) {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'cert_config').maybeSingle();
    return loadConfig(data?.value);
}

// Build the render payload the certificate templates expect.
// The LOOK (template, logo, org, body, signatories) comes from the live config so
// admin edits apply to every certificate. The per-recipient facts (name, number,
// date, earned title) stay frozen on the certificate row.
function renderData(cert, cfg) {
    return {
        template: cfg.template || cert.template || 'classic',
        org_name: cfg.org_name,
        logo_url: cfg.logo_url,
        body_text: cfg.body_text,
        signatories: cfg.signatories,
        partner_title: cert.partner_title || cfg.partner_title,
        recipient_name: cert.recipient_name,
        cert_number: cert.cert_number,
        issued_date: cert.issued_date
    };
}

/**
 * Issue (or return the existing) certificate for a partner person.
 * Exported so the graduation flow can call it directly. Best-effort caller
 * should try/catch — issuance must never block graduation.
 */
export async function issueCertificate(supabase, opts) {
    const personId = opts && opts.personId;
    if (!personId) return { ok: false, error: 'personId required' };

    const { data: existing } = await supabase.from('partner_certificates').select('*').eq('person_id', personId).maybeSingle();
    if (existing) return { ok: true, certificate: existing, created: false };

    // Resolve recipient name if not supplied.
    let name = opts.recipientName;
    if (!name) {
        const { data: p } = await supabase.from('persons').select('full_name').eq('id', personId).maybeSingle();
        name = (p && p.full_name) || 'Partner';
    }
    const cfg = await getConfig(supabase);
    let certNo = '';
    try { const { data: n } = await supabase.rpc('next_partner_cert_number'); certNo = n; } catch (e) { certNo = 'PPT-' + Date.now(); }

    const row = {
        person_id: personId,
        cert_number: certNo,
        recipient_name: name,
        partner_title: cfg.partner_title,
        template: cfg.template,
        config_snapshot: cfg,
        source: opts.source || 'graduation'
    };
    if (opts.issuedDate) row.issued_date = opts.issuedDate;

    const { data: created, error } = await supabase.from('partner_certificates').insert(row).select('*').single();
    if (error) {
        // Unique race — someone issued between our check and insert.
        const { data: again } = await supabase.from('partner_certificates').select('*').eq('person_id', personId).maybeSingle();
        if (again) return { ok: true, certificate: again, created: false };
        return { ok: false, error: error.message };
    }
    return { ok: true, certificate: created, created: true };
}

const PARTNER_ACTIONS = new Set(['my_certificate']);

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
    const action = body.action || (req.method === 'GET' ? 'get_config' : null);

    try {
        // ── PARTNER-FACING: my certificate ──────────────────────────────────
        if (PARTNER_ACTIONS.has(action)) {
            const personId = await validatePartner(supabase, body.token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });

            const { data: person } = await supabase.from('persons').select('id, full_name, enrolled_at').eq('id', personId).maybeSingle();
            const issued = await issueCertificate(supabase, {
                personId,
                recipientName: person && person.full_name,
                source: 'auto',
                // Existing partners: date the cert to when they enrolled, if known.
                issuedDate: person && person.enrolled_at ? String(person.enrolled_at).slice(0, 10) : undefined
            });
            if (!issued.ok) return res.status(500).json({ success: false, message: issued.error || 'Could not issue certificate.' });
            const cfg = await getConfig(supabase);
            return res.status(200).json({ success: true, certificate: renderData(issued.certificate, cfg) });
        }

        // ── STAFF-FACING (Bearer session) ───────────────────────────────────
        const session = await validateSession(req);
        if (!session) return sessionErrorResponse(res);

        if (action === 'get_config') {
            const cfg = await getConfig(supabase);
            return res.status(200).json({ success: true, config: cfg });
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

        if (action === 'save_config') {
            const { data: caller } = await supabase.from('app_users')
                .select('role, is_active, first_name, last_name, email').eq('userid', session.userid).maybeSingle();
            if (!caller?.is_active || caller.role !== 'super_admin') {
                return res.status(403).json({ success: false, message: 'Super admin only.' });
            }
            const cfg = loadConfig(body.config);
            const actorName = `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || caller.email;
            const { error } = await supabase.from('app_settings').upsert({
                key: 'cert_config', value: JSON.stringify(cfg), updated_at: new Date().toISOString(), updated_by: actorName
            }, { onConflict: 'key' });
            if (error) throw error;
            supabase.from('activity_logs').insert({
                email: caller.email || session.userid,
                action: `Certificate settings updated by ${actorName}`,
                status: 'success', category: 'admin', target_type: 'app_setting', target_id: 'cert_config', severity: 'info'
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true, config: cfg });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[certificates]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
}
