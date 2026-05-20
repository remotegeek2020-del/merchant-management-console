import { sendDailyReport } from './scheduled-reports.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ success: false });

    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const result = await sendDailyReport('cron');
        console.log(`[CRON] Daily report sent to ${result.sent}/${result.total} recipients`);
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        console.error('[CRON] Daily report error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
