// Serves the correct portal logo for the requesting host, server-side.
// Branded white-label domains (portal_brands.logo_url) get their own logo;
// everyone else gets the default PayProTec mark. Because the right image is
// chosen from the Host header and returned as a 302 — before any JS runs —
// the branded logo loads immediately with NO flash of the PayProTec logo.
// Pages just use <img src="/api/brand-logo">.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DEFAULT_LOGO = 'https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png';

function normHost(h) { return String(h || '').toLowerCase().replace(/^www\./, '').split(':')[0].trim(); }

export default async function handler(req, res) {
    let url = DEFAULT_LOGO;
    try {
        // ?host= override lets staff preview a brand; otherwise use the real Host.
        const host = normHost((req.query && req.query.host) || req.headers.host);
        if (host) {
            const { data } = await supabase.from('portal_brands').select('logo_url').eq('host', host).eq('active', true).maybeSingle();
            if (data && data.logo_url && String(data.logo_url).trim()) url = String(data.logo_url).trim();
        }
    } catch (e) { /* fall back to the default mark */ }
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.redirect(302, url);
}
