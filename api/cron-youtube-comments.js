import { pollAndProcessComments } from './youtube-oauth.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

// Frequent job: detect new YouTube comments (notify staff), and post any due
// AI auto-replies (random 1–10 min delay set when the comment was detected).
// No-ops cheaply if the channel isn't connected. GET (cron, Bearer CRON_SECRET).
export default async function handler(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    try {
        const r = await pollAndProcessComments();
        return res.status(200).json({ success: true, ...r });
    } catch (e) {
        return res.status(500).json({ success: false, message: e.message });
    }
}
