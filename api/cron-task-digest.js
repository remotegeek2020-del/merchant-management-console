import { sendTaskDigests } from './task-digest.js';

export const config = { api: { bodyParser: false } };

// Runs hourly; sendTaskDigests() only fires when the current UTC hour matches the
// configured send hour (app_settings.task_digest_hour_utc, default 13).
export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ success: false });

    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const result = await sendTaskDigests({ trigger: 'cron' });
        console.log('[CRON] Task digest:', JSON.stringify(result));
        return res.status(200).json({ success: true, result });
    } catch (err) {
        console.error('[CRON] Task digest error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
