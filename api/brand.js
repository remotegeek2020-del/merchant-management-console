import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { loadActor, isAdminRole } from './_access.js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function normHost(h) { return String(h || '').toLowerCase().replace(/^www\./, '').split(':')[0].trim(); }

// Only non-sensitive fields go to the (public) portal.
function publicBrand(b) {
    if (!b) return null;
    return {
        host: b.host, name: b.name || '', logo_url: b.logo_url || '', favicon_url: b.favicon_url || '',
        color_primary: b.color_primary || '', color_dark: b.color_dark || '', color_accent: b.color_accent || '',
        tagline: b.tagline || '', support_email: b.support_email || '', support_phone: b.support_phone || ''
    };
}

async function validatePartner(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

// Partner's companies (via their agents) + any per-company sub-brand.
async function partnerCompanies(personId) {
    const { data: agents } = await supabase.from('agents').select('company_id, companies:company_id(company_name)').eq('parent_agent_id', personId);
    const map = {};
    (agents || []).forEach(a => { if (a.company_id && !map[a.company_id]) map[a.company_id] = { company_id: a.company_id, company_name: (a.companies && a.companies.company_name) || 'Company' }; });
    const ids = Object.keys(map);
    if (ids.length) {
        const { data: subs } = await supabase.from('company_brands').select('*').in('company_id', ids);
        (subs || []).forEach(s => { if (map[s.company_id]) map[s.company_id].sub = { name: s.name || '', logo_url: s.logo_url || '', color_primary: s.color_primary || '', color_dark: s.color_dark || '', active: s.active !== false }; });
    }
    return ids.map(id => map[id]);
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const body = req.body || {};
    const action = body.action || (req.method === 'GET' ? 'resolve' : null);

    try {
        // ── PUBLIC: resolve a brand by hostname (the portal calls this on load) ──
        if (action === 'resolve') {
            const host = normHost(body.host || req.query?.host);
            if (!host) return res.status(200).json({ brand: null });
            const { data } = await supabase.from('portal_brands').select('*').eq('host', host).eq('active', true).maybeSingle();
            return res.status(200).json({ brand: publicBrand(data) });
        }

        // ── PARTNER: my brand + my companies (for sub-brand switcher) ───────────
        if (action === 'my_brand') {
            const personId = await validatePartner(body.token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });
            const { data: b } = await supabase.from('portal_brands').select('*').eq('partner_id', personId).eq('active', true).maybeSingle();
            const companies = await partnerCompanies(personId);
            return res.status(200).json({ success: true, brand: publicBrand(b), companies });
        }

        // ── STAFF (admin) management ────────────────────────────────────────────
        const session = await validateSession(req);
        if (!session) return sessionErrorResponse(res);
        const actor = await loadActor(session.userid);
        if (!isAdminRole(actor)) return res.status(403).json({ success: false, message: 'Admin only.' });

        if (action === 'list') {
            const { data } = await supabase.from('portal_brands').select('*').order('created_at', { ascending: false });
            return res.status(200).json({ success: true, brands: data || [] });
        }
        if (action === 'upsert') {
            const b = body.brand || {};
            const row = {
                host: normHost(b.host), partner_id: b.partner_id || null, name: b.name || null,
                logo_url: b.logo_url || null, favicon_url: b.favicon_url || null,
                color_primary: b.color_primary || null, color_dark: b.color_dark || null, color_accent: b.color_accent || null,
                tagline: b.tagline || null, support_email: b.support_email || null, support_phone: b.support_phone || null,
                active: b.active !== false, updated_at: new Date().toISOString()
            };
            if (!row.host) return res.status(400).json({ success: false, message: 'host is required.' });
            if (b.id) { const { error } = await supabase.from('portal_brands').update(row).eq('id', b.id); if (error) throw error; }
            else { const { error } = await supabase.from('portal_brands').upsert(row, { onConflict: 'host' }); if (error) throw error; }
            return res.status(200).json({ success: true });
        }
        if (action === 'delete') {
            if (!body.id) return res.status(400).json({ success: false, message: 'id required.' });
            await supabase.from('portal_brands').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }
        if (action === 'set_company_brand') {
            const s = body.sub || {};
            if (!s.company_id) return res.status(400).json({ success: false, message: 'company_id required.' });
            const { error } = await supabase.from('company_brands').upsert({
                company_id: s.company_id, name: s.name || null, logo_url: s.logo_url || null,
                color_primary: s.color_primary || null, color_dark: s.color_dark || null,
                active: s.active !== false, updated_at: new Date().toISOString()
            }, { onConflict: 'company_id' });
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[brand]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
}
