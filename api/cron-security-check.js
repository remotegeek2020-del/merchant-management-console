import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        // Check schedule setting before running
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { data: sched } = await supabase
            .from('report_schedule_settings')
            .select('schedule, enabled, preferred_hour')
            .eq('report_type', 'security')
            .maybeSingle();

        // Defaults: daily at 8 AM UTC
        const schedule = sched?.schedule ?? 'daily';
        const enabled = sched?.enabled !== false;
        const preferredHour = sched?.preferred_hour ?? 8;
        const currentHour = new Date().getUTCHours();

        if (!enabled) {
            return res.status(200).json({ success: true, skipped: 'disabled' });
        }

        // For daily: run once at preferred_hour
        // For twice_daily: run at preferred_hour and preferred_hour+12
        // For weekly: only run on Monday (day 1)
        let shouldRun = false;
        if (schedule === 'daily') {
            shouldRun = currentHour === preferredHour;
        } else if (schedule === 'twice_daily') {
            shouldRun = currentHour === preferredHour || currentHour === (preferredHour + 12) % 24;
        } else if (schedule === 'weekly') {
            const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 1=Mon
            shouldRun = dayOfWeek === 1 && currentHour === preferredHour;
        }

        if (!shouldRun) {
            return res.status(200).json({ success: true, skipped: `not scheduled (current hour: ${currentHour} UTC, schedule: ${schedule} at ${preferredHour}h UTC)` });
        }

        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
        const baseUrl = `${proto}://${host}`;

        const response = await fetch(`${baseUrl}/api/security-check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'run_check', triggered_by: 'cron' })
        });

        const data = await response.json();
        if (!data.success) {
            console.error('[CRON] Security check failed:', data.message);
            return res.status(500).json({ success: false, message: data.message });
        }

        console.log('[CRON] Security check completed. Overall status:', data.report?.overall_status);
        return res.status(200).json({ success: true, overall_status: data.report?.overall_status });

    } catch (err) {
        console.error('[CRON] Security check error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
