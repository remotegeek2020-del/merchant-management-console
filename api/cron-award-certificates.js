import { createClient } from '@supabase/supabase-js';
import { runAwardAutomation } from './certificates.js';

// Daily job: auto-award partner certificates for every milestone/leaderboard/POS
// rule a partner meets (Marketing → Partner Portal → Automation). Idempotent.
export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    try {
        const summary = await runAwardAutomation(supabase);
        console.log('[CRON award-certificates]', JSON.stringify(summary));
        return res.status(200).json({ success: true, ...summary });
    } catch (err) {
        console.error('[CRON award-certificates] error:', err.message);
        return res.status(200).json({ success: false, message: err.message });
    }
}
