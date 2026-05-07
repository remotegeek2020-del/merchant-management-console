export default async function handler(req, res) {
    // Vercel cron jobs send GET requests
    if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Method not allowed' });

    // Verify this is an authorized Vercel cron call
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = req.headers.authorization;
        if (authHeader !== `Bearer ${cronSecret}`) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }
    }

    try {
        // Build the base URL from the request or Vercel env
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
