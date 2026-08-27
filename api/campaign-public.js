// ── PUBLIC CAMPAIGN STATS VIEW (read-only, token-gated share link) ───────────
// Serves one campaign's stats (conversions first) to anyone holding the share
// token, but only while the link is live (share_active + within share_until).
import { createClient } from '@supabase/supabase-js';
import { buildStatsSummary } from './marketing.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const token = String(body?.token || '').trim();
    if (!token) return res.status(200).json({ success: false, message: 'Missing token.' });

    const { data: c } = await supabase.from('marketing_campaigns')
        .select('id, title, share_active, share_until, share_show_contacts').eq('share_token', token).maybeSingle();
    if (!c) return res.status(200).json({ success: false, message: 'This link is not valid.' });

    const live = !!(c.share_active && (!c.share_until || new Date(c.share_until + 'T23:59:59') >= new Date()));
    if (!live) {
        const reason = !c.share_active ? 'This share link is turned off.' : 'This share link has expired.';
        return res.status(200).json({ success: false, inactive: true, message: reason });
    }

    const summary = await buildStatsSummary(c.id);
    if (!summary) return res.status(200).json({ success: false, message: 'Campaign not found.' });

    // Respect the "show contacts" toggle: strip the conversion name/email list if off.
    if (c.share_show_contacts === false && summary.conversions) {
        summary.conversions = { ...summary.conversions, list: [] };
        summary.contacts_hidden = true;
    }
    return res.status(200).json({ success: true, summary });
}
