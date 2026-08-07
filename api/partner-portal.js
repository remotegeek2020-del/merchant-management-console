import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { loadActor, actorName, canMarketing } from './_access.js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

// ── defaults ─────────────────────────────────────────────────────────────────
const DEFAULT_JOURNEY = [
    { icon: 'explore', title: 'Discovered PayProTec', desc: 'You found the partner opportunity and joined as a prospect.', rule: 'always' },
    { icon: 'assignment_turned_in', title: 'Completed Onboarding', desc: 'You shared your goals so we could tailor your path.', rule: 'always' },
    { icon: 'handshake', title: 'Met the Team', desc: 'You connected with a PayProTec rep on your become-a-partner call.', rule: 'always' },
    { icon: 'workspace_premium', title: 'Became a Partner', desc: 'Welcome to the PayProTec family — your Partner Portal is live!', rule: 'always' },
    { icon: 'storefront', title: 'First Merchant Approved', desc: 'Your first approved merchant account is on the books.', rule: 'approved_1' },
    { icon: 'trending_up', title: 'Building Your Portfolio', desc: '10+ approved merchants — momentum is building.', rule: 'approved_10' },
    { icon: 'rocket_launch', title: 'Scaling Up', desc: "50+ approved merchants. You're a force. 🚀", rule: 'approved_50' }
];
const DEFAULT_SECTIONS = { certificate: true, journey: true, leaderboard: true, community: true, webinars: true };
const DEFAULT_TIERS = { gold: 3, silver: 10 };
const DEFAULT_WELCOME = { title: '', text: '' };

const RULES = ['always', 'approved_1', 'approved_5', 'approved_10', 'approved_25', 'approved_50'];

function parse(raw, fallback) {
    if (raw == null) return fallback;
    try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return v == null ? fallback : v; } catch (e) { return fallback; }
}
function cleanJourney(a) {
    if (!Array.isArray(a)) return DEFAULT_JOURNEY;
    const out = a.map(m => ({
        icon: String(m.icon || 'star').slice(0, 40),
        title: String(m.title || '').slice(0, 120),
        desc: String(m.desc || '').slice(0, 300),
        rule: RULES.indexOf(String(m.rule)) >= 0 ? m.rule : 'always'
    })).filter(m => m.title).slice(0, 12);
    return out.length ? out : DEFAULT_JOURNEY;
}
function cleanSections(o) {
    o = (o && typeof o === 'object') ? o : {};
    const out = {};
    Object.keys(DEFAULT_SECTIONS).forEach(k => { out[k] = o[k] === undefined ? DEFAULT_SECTIONS[k] : !!o[k]; });
    return out;
}
function cleanTiers(o) {
    o = (o && typeof o === 'object') ? o : {};
    let gold = parseInt(o.gold, 10); let silver = parseInt(o.silver, 10);
    if (!(gold >= 1)) gold = DEFAULT_TIERS.gold;
    if (!(silver > gold)) silver = Math.max(gold + 1, DEFAULT_TIERS.silver);
    return { gold, silver };
}
function cleanWelcome(o) {
    o = (o && typeof o === 'object') ? o : {};
    return { title: String(o.title || '').slice(0, 120), text: String(o.text || '').slice(0, 400) };
}

async function readSettings(supabase) {
    const { data } = await supabase.from('app_settings').select('key, value')
        .in('key', ['partner_journey', 'partner_sections', 'partner_tiers', 'partner_welcome']);
    const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
    return {
        journey: cleanJourney(parse(map.partner_journey, DEFAULT_JOURNEY)),
        sections: cleanSections(parse(map.partner_sections, DEFAULT_SECTIONS)),
        tiers: cleanTiers(parse(map.partner_tiers, DEFAULT_TIERS)),
        welcome: cleanWelcome(parse(map.partner_welcome, DEFAULT_WELCOME))
    };
}

// Read the leaderboard tier thresholds (used by api/partners.js).
export async function getPartnerTiers(supabase) {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'partner_tiers').maybeSingle();
    return cleanTiers(parse(data?.value, DEFAULT_TIERS));
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const body = req.body || {};
    const action = body.action || (req.method === 'GET' ? 'public_config' : null);

    try {
        // ── PARTNER-FACING: config the portal needs to render (no secrets) ──
        if (action === 'public_config') {
            const s = await readSettings(supabase);
            return res.status(200).json({ success: true, journey: s.journey, sections: s.sections, welcome: s.welcome });
        }

        // ── STAFF ───────────────────────────────────────────────────────────
        const session = await validateSession(req);
        if (!session) return sessionErrorResponse(res);
        const actor = await loadActor(session.userid);

        if (action === 'get_settings') {
            if (!canMarketing(actor)) return res.status(403).json({ success: false, message: 'No access.' });
            const s = await readSettings(supabase);
            return res.status(200).json({ success: true, settings: s });
        }

        if (action === 'save_settings') {
            if (!canMarketing(actor)) return res.status(403).json({ success: false, message: 'No access.' });
            const s = body.settings || {};
            const now = new Date().toISOString();
            const who = actorName(actor);
            const rows = [];
            if (s.journey !== undefined) rows.push({ key: 'partner_journey', value: JSON.stringify(cleanJourney(s.journey)), updated_at: now, updated_by: who });
            if (s.sections !== undefined) rows.push({ key: 'partner_sections', value: JSON.stringify(cleanSections(s.sections)), updated_at: now, updated_by: who });
            if (s.tiers !== undefined) rows.push({ key: 'partner_tiers', value: JSON.stringify(cleanTiers(s.tiers)), updated_at: now, updated_by: who });
            if (s.welcome !== undefined) rows.push({ key: 'partner_welcome', value: JSON.stringify(cleanWelcome(s.welcome)), updated_at: now, updated_by: who });
            if (rows.length) { const { error } = await supabase.from('app_settings').upsert(rows, { onConflict: 'key' }); if (error) throw error; }
            supabase.from('activity_logs').insert({
                email: actor.email || session.userid, action: `Partner portal settings updated by ${who}`,
                status: 'success', category: 'admin', target_type: 'app_setting', target_id: 'partner_portal', severity: 'info'
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true, settings: await readSettings(supabase) });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[partner-portal]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
}
