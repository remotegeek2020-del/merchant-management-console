// Serves the site favicon set in Secret Dungeon → Portal CMS → Branding
// (site_settings.favicon_url). Falls back to the bundled default. Pages link to
// /api/favicon so the CMS branding controls the favicon everywhere, no JS needed.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    let url = '/images/favicon-32x32.png';
    try {
        const { data } = await supabase.from('site_settings').select('value').eq('key', 'favicon_url').maybeSingle();
        if (data?.value && String(data.value).trim()) url = String(data.value).trim();
    } catch (e) { /* fall back to the default */ }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.redirect(302, url);
}
