// Public QR redirect: /go/<code> → logs a scan → forwards to the video's CTA
// (HighLevel form or calendar). No auth (anyone scanning), best-effort logging.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const FALLBACK = 'https://portal.mypayprotec.com';

export default async function handler(req, res) {
    const code = String((req.query && (req.query.c || req.query.code)) || '').trim();
    if (!code) return res.redirect(302, FALLBACK);
    try {
        const { data: v } = await supabase.from('course_videos')
            .select('id, qr_enabled, ai_cta_link, ai_goal').eq('qr_code', code).maybeSingle();
        if (!v || !v.qr_enabled || !v.ai_cta_link) return res.redirect(302, FALLBACK);

        // Log the scan (best-effort — never block the redirect).
        try {
            await supabase.from('qr_scans').insert({
                qr_code: code, course_video_id: v.id,
                ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
                user_agent: req.headers['user-agent'] || null,
                referrer: req.headers['referer'] || req.headers['referrer'] || null
            });
        } catch { /* ignore */ }

        // Attribution params so HighLevel can see it came from the on-stream QR.
        let target = v.ai_cta_link;
        const utm = 'utm_source=portal_qr&utm_medium=livestream&utm_campaign=' + encodeURIComponent(v.id);
        target += (target.includes('?') ? '&' : '?') + utm;
        return res.redirect(302, target);
    } catch (e) {
        return res.redirect(302, FALLBACK);
    }
}
