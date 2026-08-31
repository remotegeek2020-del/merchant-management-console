// ── PRIME 49 UPGRADE DETECTOR (staff) ────────────────────────────────────────
// Finds merchants that qualify for a Prime 49 upgrade (Approved, not already
// Prime49, 30-day volume >= threshold) and groups them by partner — the
// foundation for personalized "upgrade to Prime 49" announcements/outreach.
// Threshold guidance from the program: ~$15k/mo minimum, $20k+ adds a POS credit.
import { createClient } from '@supabase/supabase-js';
import { validateSession as validateStaff, sessionErrorResponse } from './_validate.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ok = (res, data = {}) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

const REBATE_BPS = 0.004; // ~40 basis points monthly rebate to the merchant

async function getThreshold() {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'prime49_min_volume').maybeSingle();
    const n = Number(data && data.value);
    return Number.isFinite(n) && n > 0 ? n : 15000;
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
    const session = await validateStaff(req);
    if (!session) return sessionErrorResponse(res);
    const { data: caller } = await supabase.from('app_users')
        .select('role, access_marketing').eq('userid', session.userid).maybeSingle();
    const canAccess = !!caller && (caller.role === 'super_admin' || caller.role === 'admin' || caller.access_marketing === true);
    if (!canAccess) return bad(res, 'Access denied.', 403);

    const action = req.body?.action;
    try {
        if (action === 'get_threshold') {
            return ok(res, { threshold: await getThreshold() });
        }
        if (action === 'set_threshold') {
            const n = Number(req.body.threshold);
            if (!Number.isFinite(n) || n <= 0) return bad(res, 'Enter a valid dollar amount.');
            await supabase.from('app_settings').upsert({ key: 'prime49_min_volume', value: String(Math.round(n)), updated_at: new Date().toISOString() }, { onConflict: 'key' });
            return ok(res, { threshold: Math.round(n) });
        }

        // Scan: summary per partner (sorted by opportunity), plus totals.
        if (action === 'scan') {
            const threshold = req.body.threshold ? Number(req.body.threshold) : await getThreshold();
            const { data, error } = await supabase.rpc('prime49_upgrade_candidates', { min_vol: threshold });
            if (error) throw error;
            const rows = data || [];
            const byPartner = {};
            let totVol = 0, posTotal = 0;
            rows.forEach(r => {
                const key = r.partner_full_name || '—';
                const g = byPartner[key] || (byPartner[key] = { partner_full_name: key, count: 0, vol30: 0, pos_count: 0 });
                g.count++; g.vol30 += Number(r.vol30) || 0;
                if (r.pos_eligible) { g.pos_count++; posTotal++; }
                totVol += Number(r.vol30) || 0;
            });
            const partners = Object.values(byPartner)
                .map(g => ({ ...g, est_monthly_rebate: Math.round(g.vol30 * REBATE_BPS) }))
                .sort((a, b) => b.count - a.count || b.vol30 - a.vol30);
            return ok(res, {
                threshold,
                totals: {
                    partners: partners.length,
                    merchants: rows.length,
                    pos_eligible: posTotal,
                    total_vol: Math.round(totVol),
                    est_monthly_rebate: Math.round(totVol * REBATE_BPS)
                },
                partners
            });
        }

        // Per-partner merchant detail (drill-down).
        if (action === 'partner_detail') {
            const name = String(req.body.partner_full_name || '');
            if (!name) return bad(res, 'partner_full_name required');
            const threshold = req.body.threshold ? Number(req.body.threshold) : await getThreshold();
            const { data, error } = await supabase.rpc('prime49_upgrade_candidates', { min_vol: threshold });
            if (error) throw error;
            const rows = (data || []).filter(r => (r.partner_full_name || '—') === name)
                .map(r => ({
                    merchant_id: r.merchant_id, dba_name: r.dba_name, state: r.merchant_state,
                    email: r.email, phone: r.phone, vol30: Math.round(Number(r.vol30) || 0),
                    pos_eligible: !!r.pos_eligible, est_rebate: Math.round((Number(r.vol30) || 0) * REBATE_BPS)
                }))
                .sort((a, b) => b.vol30 - a.vol30);
            return ok(res, { partner_full_name: name, merchants: rows });
        }

        // ── Two-path CTA / landing config ────────────────────────────────────
        if (action === 'get_cta') {
            const { data } = await supabase.from('app_settings').select('value').eq('key', 'prime49_cta').maybeSingle();
            let cfg = {}; try { cfg = data && data.value ? JSON.parse(data.value) : {}; } catch { cfg = {}; }
            const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            return ok(res, { cta: cfg, public_url: `${proto}://${host}/prime49` });
        }
        if (action === 'set_cta') {
            const b = req.body.cta || {};
            const cfg = {
                headline: String(b.headline || '').slice(0, 200),
                subtext: String(b.subtext || '').slice(0, 500),
                // Non-partner path
                nonpartner_mode: ['form', 'calendar', 'link'].includes(b.nonpartner_mode) ? b.nonpartner_mode : 'form',
                nonpartner_url: String(b.nonpartner_url || '').slice(0, 1000),
                nonpartner_label: String(b.nonpartner_label || '').slice(0, 120),
                // Partner → qualified path
                qualified_mode: ['embed', 'link'].includes(b.qualified_mode) ? b.qualified_mode : 'link',
                qualified_url: String(b.qualified_url || '').slice(0, 1000),
                qualified_headline: String(b.qualified_headline || '').slice(0, 200),
                // Partner → not-qualified path (coaches consideration form)
                notqualified_mode: ['embed', 'link'].includes(b.notqualified_mode) ? b.notqualified_mode : 'embed',
                notqualified_url: String(b.notqualified_url || '').slice(0, 1000),
                notqualified_headline: String(b.notqualified_headline || '').slice(0, 200)
            };
            await supabase.from('app_settings').upsert({ key: 'prime49_cta', value: JSON.stringify(cfg), updated_at: new Date().toISOString() }, { onConflict: 'key' });
            return ok(res, { cta: cfg });
        }

        return bad(res, 'Unknown action');
    } catch (err) {
        console.error('Prime49 Upgrade Error:', err.message);
        return bad(res, err.message, 500);
    }
}
