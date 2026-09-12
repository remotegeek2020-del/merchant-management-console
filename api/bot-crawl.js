// ── Website bot — crawler (Phase 6) ──────────────────────────────────────────
// Multi-page, link-following crawl of a bot's own website, feeding
// bot_knowledge automatically instead of staff pasting content by hand.
// Deliberately conservative: same-hostname only, a hard page cap, and a wall-
// clock budget so it always finishes cleanly within Vercel's function limit
// rather than timing out mid-crawl. Reuses the exact fetch/strip/extract
// pattern already proven in api/jarvis-ingest.js's single-URL ingestion.
//
// runCrawlJob() is shared with api/cron-bot-crawl.js, which re-runs any job
// marked auto_recrawl on a schedule to keep knowledge fresh.
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { getConfigValue } from './api-config.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const HARD_MAX_PAGES = 15;
const TIME_BUDGET_MS = 45000; // leaves headroom under the 60s function limit

function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '').replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}
function extractLinks(html, baseUrl) {
    const out = new Set();
    const re = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
    let m;
    while ((m = re.exec(html))) {
        try {
            const u = new URL(m[1], baseUrl);
            u.hash = '';
            if (/^https?:$/.test(u.protocol)) out.add(u.href);
        } catch (e) { /* ignore malformed */ }
    }
    return Array.from(out);
}
async function fetchPage(url) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 12000);
    try {
        const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PayProTecBot/1.0)' } });
        clearTimeout(t);
        if (!r.ok) return null;
        return await r.text();
    } catch (e) { clearTimeout(t); return null; }
}
async function extractChunks(key, text, sourceUrl, botName) {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `You are building a knowledge base for a website chat assistant${botName ? ' called ' + botName : ''}.

From the following page content, extract 2-8 distinct, useful facts a visitor might ask about (services, pricing, process, requirements, contact info, policies, etc). Skip navigation/boilerplate/unrelated fluff.

Output ONLY a strict JSON array: [{"topic": "short label", "content": "the fact in 1-3 sentences"}]. If nothing useful, return [].

Page (${sourceUrl}):
${text.slice(0, 20000)}`;
    try {
        const result = await model.generateContent(prompt);
        const raw = (result.response.text() || '').trim();
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) return [];
        return JSON.parse(match[0]);
    } catch (e) { return []; }
}

// Runs one crawl job (already-inserted bot_crawl_jobs row) start to finish
// and writes its own status/results back. Used by both the on-demand HTTP
// action and the recurring cron.
export async function runCrawlJob(job, botName, key) {
    let startHost;
    try { startHost = new URL(job.start_url).hostname; } catch (e) {
        await supabase.from('bot_crawl_jobs').update({ status: 'error', error: 'Invalid start URL' }).eq('id', job.id);
        return { pages_crawled: 0, chunks_added: 0 };
    }
    await supabase.from('bot_crawl_jobs').update({ status: 'running' }).eq('id', job.id);

    const startedAt = Date.now();
    const visited = new Set(), queue = [job.start_url];
    let pagesCrawled = 0, chunksAdded = 0;

    while (queue.length && pagesCrawled < job.max_pages && (Date.now() - startedAt) < TIME_BUDGET_MS) {
        const url = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);
        const html = await fetchPage(url);
        if (!html) continue;
        pagesCrawled++;

        const text = stripHtml(html);
        if (text.length > 100) {
            const chunks = await extractChunks(key, text, url, botName);
            if (chunks.length) {
                await supabase.from('bot_knowledge').insert(
                    chunks.map(c => ({ bot_id: job.bot_id, topic: String(c.topic || '').slice(0, 200) || null, content: String(c.content || '').slice(0, 2000), source: url }))
                );
                chunksAdded += chunks.length;
            }
        }
        if ((Date.now() - startedAt) < TIME_BUDGET_MS) {
            const links = extractLinks(html, url).filter(l => { try { return new URL(l).hostname === startHost; } catch { return false; } });
            for (const l of links) if (!visited.has(l) && !queue.includes(l)) queue.push(l);
        }
    }

    await supabase.from('bot_crawl_jobs').update({
        status: 'done', pages_crawled: pagesCrawled, chunks_added: chunksAdded, last_run_at: new Date().toISOString()
    }).eq('id', job.id);
    return { pages_crawled: pagesCrawled, chunks_added: chunksAdded };
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    res.setHeader('Content-Type', 'application/json');
    const body = req.body || {};
    const action = body.action;

    try {
        if (action === 'list_jobs') {
            const { data } = await supabase.from('bot_crawl_jobs').select('*').eq('bot_id', body.bot_id).order('created_at', { ascending: false });
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'crawl') {
            const botId = body.bot_id;
            let startUrl = String(body.start_url || '').trim();
            if (!botId) return res.status(200).json({ success: false, message: 'bot_id required' });
            if (!/^https?:\/\//i.test(startUrl)) startUrl = 'https://' + startUrl;
            try { new URL(startUrl); } catch (e) { return res.status(200).json({ success: false, message: 'Invalid URL' }); }
            const maxPages = Math.min(HARD_MAX_PAGES, Math.max(1, parseInt(body.max_pages, 10) || 8));

            const { data: bot } = await supabase.from('bots').select('id, name').eq('id', botId).maybeSingle();
            if (!bot) return res.status(200).json({ success: false, message: 'Bot not found' });
            const key = process.env.GEMINI_API_KEY || (await getConfigValue('GEMINI_API_KEY')) || '';
            if (!key) return res.status(200).json({ success: false, message: 'Gemini is not configured.' });

            const { data: job } = await supabase.from('bot_crawl_jobs').insert({
                bot_id: botId, start_url: startUrl, max_pages: maxPages, status: 'running', auto_recrawl: !!body.auto_recrawl
            }).select('*').single();

            const result = await runCrawlJob(job, bot.name, key);
            return res.status(200).json({ success: true, ...result, job_id: job.id });
        }

        if (action === 'delete_job') {
            if (!body.id) return res.status(200).json({ success: false, message: 'Missing id.' });
            await supabase.from('bot_crawl_jobs').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        return res.status(200).json({ success: false, message: 'Unknown action' });
    } catch (e) {
        console.error('[bot-crawl]', e.message);
        return res.status(200).json({ success: false, message: 'An unexpected error occurred.' });
    }
}
