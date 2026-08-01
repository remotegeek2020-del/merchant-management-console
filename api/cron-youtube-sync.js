import { createClient } from '@supabase/supabase-js';
import { syncCourseFromYouTube } from './courses.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

// Hourly: pull each sync-enabled course's YouTube channel live broadcasts into
// the course (new past/live streams appear automatically).
// GET (cron, Authorization: Bearer CRON_SECRET).

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    try {
        const { data: courses } = await supabase.from('courses').select('*').eq('yt_sync_enabled', true);
        const results = [];
        for (const c of (courses || [])) {
            if (!c.yt_channel_id) continue;
            try { const r = await syncCourseFromYouTube(c); results.push({ course: c.title, ...r }); }
            catch (e) { results.push({ course: c.title, ok: false, error: e.message }); }
        }
        return res.status(200).json({ success: true, synced: results.length, results });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
}
