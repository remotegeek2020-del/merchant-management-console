import { sendScheduledReports } from './scheduled-reports.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ success: false });

    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        const currentHour = new Date().getUTCHours();
        const results = await sendScheduledReports('weekly', 'cron', currentHour);
        const summary = results.map(r => `${r.report_type}: ${r.sent ?? 'skipped'}`).join(', ');
        console.log(`[CRON] Weekly reports (hour ${currentHour}): ${summary}`);
        return res.status(200).json({ success: true, results });
    } catch (err) {
        console.error('[CRON] Weekly report error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
