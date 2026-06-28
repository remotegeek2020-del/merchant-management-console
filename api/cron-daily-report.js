import { sendScheduledReports } from './scheduled-reports.js';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

// Best-effort cleanup of ALREADY-EXPIRED auth records. Only deletes rows whose
// expires_at is in the past (already invalid), so it never affects live sessions.
async function purgeExpiredAuth() {
    try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const nowIso = new Date().toISOString();
        const [td, ss] = await Promise.all([
            supabase.from('trusted_devices').delete().lt('expires_at', nowIso).select('userid'),
            supabase.from('staff_sessions').delete().lt('expires_at', nowIso).select('session_token')
        ]);
        console.log(`[CRON] Purged ${td.data?.length || 0} expired trusted device(s), ${ss.data?.length || 0} expired staff session(s)`);
    } catch (e) {
        console.error('[CRON] purgeExpiredAuth error (non-blocking):', e.message);
    }
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ success: false });

    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        await purgeExpiredAuth();   // housekeeping — never blocks the report
        const currentHour = new Date().getUTCHours();
        const results = await sendScheduledReports('daily', 'cron', currentHour);
        const summary = results.map(r => `${r.report_type}: ${r.sent ?? 'skipped'}`).join(', ');
        console.log(`[CRON] Daily reports (hour ${currentHour}): ${summary}`);
        return res.status(200).json({ success: true, results });
    } catch (err) {
        console.error('[CRON] Daily report error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
