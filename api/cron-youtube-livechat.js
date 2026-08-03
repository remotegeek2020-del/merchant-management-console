import { pollLiveChat } from './youtube-oauth.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

// Runs every minute. When a broadcast is LIVE, it loops for ~50s polling the
// live chat and replying selectively (questions only, throttled, staggered).
// When nothing is live it returns immediately after one cheap check.
// GET (cron, Bearer CRON_SECRET).
export default async function handler(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    try {
        const deadline = Date.now() + 52000;   // stay under the 60s function limit
        const r = await pollLiveChat(deadline);
        return res.status(200).json({ success: true, ...r });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
}
