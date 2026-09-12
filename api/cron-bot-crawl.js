// ── Website bot — weekly auto-recrawl (Phase 6) ──────────────────────────────
// Re-runs any crawl job staff marked auto_recrawl=true, so knowledge stays
// fresh without a person remembering to re-trigger it manually. Runs one job
// at a time to stay well within the function's time budget.
import { createClient } from '@supabase/supabase-js';
import { getConfigValue } from './api-config.js';
import { runCrawlJob } from './bot-crawl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    try {
        const key = process.env.GEMINI_API_KEY || (await getConfigValue('GEMINI_API_KEY')) || '';
        if (!key) return res.status(200).json({ success: false, message: 'Gemini not configured' });

        // Due = auto_recrawl jobs not run (or last run) in the past 7 days.
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: jobs } = await supabase.from('bot_crawl_jobs')
            .select('*').eq('auto_recrawl', true).or(`last_run_at.is.null,last_run_at.lte.${cutoff}`).limit(5);

        let processed = 0;
        for (const job of (jobs || [])) {
            const { data: bot } = await supabase.from('bots').select('name').eq('id', job.bot_id).maybeSingle();
            await runCrawlJob(job, bot?.name, key);
            processed++;
        }
        return res.status(200).json({ success: true, processed });
    } catch (e) {
        console.error('[cron-bot-crawl]', e.message);
        return res.status(200).json({ success: false, message: e.message });
    }
}
