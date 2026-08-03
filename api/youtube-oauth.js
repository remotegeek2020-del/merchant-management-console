// ── YouTube Analytics OAuth (portal-attributed video views) ─────────────────
// The YouTube *Data* API key (courses.js) gives a video's TOTAL public views.
// To attribute views to OUR portal specifically, we need the YouTube *Analytics*
// API, which requires OAuth as the channel owner. This module handles:
//   • one-time connect (OAuth consent → refresh token, stored encrypted)
//   • refreshing per-video "embedded on our portal" view counts
// It is entirely optional: if the channel is never connected, nothing changes
// and the other two counts (portal plays + total YouTube views) keep working.
//
// POST actions (staff + marketing): status, set_client, start, disconnect,
//   set_hosts, refresh_portal_views.
// GET with ?code=…&state=… : OAuth callback (Google redirects here).

import { createClient } from '@supabase/supabase-js';
import { validateSession } from './_validate.js';
import { setConfigValue, getConfigValue } from './api-config.js';
import { loadActor, actorName, canMarketing, canMarketingSettings } from './_access.js';
import { logActivity } from './_activity.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// yt-analytics.readonly → analytics reports; youtube.force-ssl → read comments
// AND reply to them as the channel (needed for the in-portal comment replies).
const SCOPES = [
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl'
].join(' ');

const ok = (res, data) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// The redirect URI must EXACTLY match what's registered in the Google Cloud
// OAuth client. We derive it from the request host so it's the same in start
// and callback. Register: https://<host>/api/youtube-oauth
function redirectUri(req) {
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}/api/youtube-oauth`;
}

async function clientCreds() {
    return {
        id: await getConfigValue('YT_OAUTH_CLIENT_ID'),
        secret: await getConfigValue('YT_OAUTH_CLIENT_SECRET')
    };
}

// Exchange the stored refresh token for a fresh access token.
async function accessToken() {
    const { id, secret } = await clientCreds();
    const refresh = await getConfigValue('YT_OAUTH_REFRESH_TOKEN');
    if (!id || !secret || !refresh) return null;
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }).toString()
    });
    const j = await r.json().catch(() => ({}));
    return r.ok ? j.access_token : null;
}

// Portal host(s) to attribute embedded views to (comma list, case-insensitive).
async function portalHosts() {
    const raw = (await getConfigValue('YT_PORTAL_HOSTS')) || 'portal.mypayprotec.com';
    return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function ytVideoId(v) {
    if (v.source_ref) return v.source_ref;
    const m = String(v.url || '').match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{6,})/);
    return m ? m[1] : null;
}

// For one video: lifetime embedded-player views whose embedding domain matches
// one of our portal hosts. Returns a number (0 if none/unavailable).
async function portalViewsForVideo(token, videoId, hosts, endDate) {
    const params = new URLSearchParams({
        ids: 'channel==MINE',
        startDate: '2005-01-01',
        endDate,
        metrics: 'views',
        dimensions: 'insightTrafficSourceDetail',
        filters: `video==${videoId};insightTrafficSourceType==EMBEDDED`,
        sort: '-views',
        maxResults: '25'
    });
    const r = await fetch('https://youtubeanalytics.googleapis.com/v2/reports?' + params.toString(), {
        headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;   // null = couldn't fetch (leave prior value)
    const j = await r.json().catch(() => ({}));
    let sum = 0;
    for (const row of (j.rows || [])) {
        const domain = String(row[0] || '').toLowerCase();
        const views = Number(row[1]) || 0;
        if (hosts.some(h => domain === h || domain.includes(h))) sum += views;
    }
    return sum;
}

// Is the Analytics channel connected (client creds + refresh token present)?
export async function ytAnalyticsConfigured() {
    const { id, secret } = await clientCreds();
    const refresh = await getConfigValue('YT_OAUTH_REFRESH_TOKEN');
    return !!(id && secret && refresh);
}

// Does the current connection include the comment write scope? (Older
// connections granted before force-ssl was added won't — they must reconnect.)
async function ytHasCommentScope() {
    const s = (await getConfigValue('YT_OAUTH_SCOPES')) || '';
    return s.includes('youtube.force-ssl');
}

// YouTube Data API v3 helpers (OAuth token).
async function ytDataGet(token, path) {
    try {
        const r = await fetch('https://www.googleapis.com/youtube/v3/' + path, { headers: { Authorization: 'Bearer ' + token } });
        const j = await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, j };
    } catch (e) { return { ok: false, status: 0, j: null }; }
}
async function ytDataPost(token, path, body) {
    try {
        const r = await fetch('https://www.googleapis.com/youtube/v3/' + path, {
            method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const j = await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, j };
    } catch (e) { return { ok: false, status: 0, j: null }; }
}

// Rich per-video analytics (aggregate — YouTube never exposes viewer identity).
// Returns null if not connected / unavailable.
export async function fetchVideoAnalytics(videoId) {
    const token = await accessToken();
    if (!token || !videoId) return null;
    const endDate = new Date().toISOString().slice(0, 10);
    const base = 'https://youtubeanalytics.googleapis.com/v2/reports';
    const common = `ids=channel==MINE&startDate=2005-01-01&endDate=${endDate}&filters=video==${encodeURIComponent(videoId)}`;
    const num = (v) => Number(v) || 0;
    async function q(extra) {
        try {
            const r = await fetch(base + '?' + common + extra, { headers: { Authorization: 'Bearer ' + token } });
            if (!r.ok) return null;
            return await r.json().catch(() => null);
        } catch { return null; }
    }
    const totals = await q('&metrics=views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained');
    const traffic = await q('&metrics=views&dimensions=insightTrafficSourceType&sort=-views&maxResults=15');
    const countries = await q('&metrics=views&dimensions=country&sort=-views&maxResults=5');
    if (!totals && !traffic && !countries) return null;
    const t = (totals && totals.rows && totals.rows[0]) || [];
    return {
        views: num(t[0]), minutesWatched: num(t[1]), avgDuration: num(t[2]),
        likes: num(t[3]), comments: num(t[4]), shares: num(t[5]), subscribersGained: num(t[6]),
        trafficSources: ((traffic && traffic.rows) || []).map(r => ({ type: r[0], views: num(r[1]) })),
        countries: ((countries && countries.rows) || []).map(r => ({ country: r[0], views: num(r[1]) }))
    };
}

// ── AI auto-reply config ─────────────────────────────────────────────────────
async function geminiKey() { return process.env.GEMINI_API_KEY || (await getConfigValue('GEMINI_API_KEY')) || ''; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };

export async function getAiConfig() {
    const enabled = (await getConfigValue('YT_AI_AUTOREPLY_ENABLED')) === 'true';
    let min = parseInt(await getConfigValue('YT_AI_DELAY_MIN'), 10); if (!Number.isFinite(min) || min < 1) min = 1;
    let max = parseInt(await getConfigValue('YT_AI_DELAY_MAX'), 10); if (!Number.isFinite(max) || max < min) max = Math.max(min, 10);
    // Live-chat responder (separate, faster).
    const live_enabled = (await getConfigValue('YT_LIVE_ENABLED')) === 'true';
    const live_max_per_min = clampInt(await getConfigValue('YT_LIVE_MAX_PM'), 1, 30, 4);
    const live_delay_min_sec = clampInt(await getConfigValue('YT_LIVE_DELAY_MIN'), 0, 120, 3);
    const live_delay_max_sec = Math.max(live_delay_min_sec, clampInt(await getConfigValue('YT_LIVE_DELAY_MAX'), 0, 300, 20));
    const live_questions_only = (await getConfigValue('YT_LIVE_QONLY')) !== 'false';   // default true
    return {
        enabled, min_minutes: min, max_minutes: max, gemini_set: !!(await geminiKey()),
        live_enabled, live_max_per_min, live_delay_min_sec, live_delay_max_sec, live_questions_only
    };
}

// Generate a reply to a comment with Gemini (analyzing the comment + video).
export async function generateCommentReply(comment, video) {
    const key = await geminiKey();
    if (!key) return null;
    try {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0.7 } });
        const prompt = `You are the PayProTec team replying to a comment on our own YouTube video, as the channel owner.
Video title: "${video?.title || ''}"
Video description (context): ${String(video?.description || '').slice(0, 700)}
A viewer named "${comment?.author || 'viewer'}" commented: "${String(comment?.text || '').slice(0, 700)}"

Write a warm, concise, genuinely helpful reply as PayProTec — 1 to 3 sentences, professional and friendly.
- Address their comment specifically; if they ask something, answer or point them the right way.
- If the comment is spam, offensive, or nonsensical, reply briefly and politely (or a simple thank-you).
- No hashtags, no emojis overload (at most one), no surrounding quotes, plain text only.
Reply text only:`;
        const r = await model.generateContent(prompt);
        let t = (r?.response?.text() || '').trim();
        t = t.replace(/^["'`\s]+|["'`\s]+$/g, '').slice(0, 900);
        return t || null;
    } catch (e) { return null; }
}

// Notify marketing staff (global bell = user_notifications) of a new comment.
async function notifyNewComment(video, row) {
    try {
        const { data: staff } = await supabase.from('app_users')
            .select('userid, role, is_active, access_marketing').limit(2000);
        const recips = (staff || []).filter(u => u.is_active !== false &&
            (String(u.role || '').toLowerCase().match(/admin|super/) || u.access_marketing === true));
        if (recips.length) {
            const body = `${row.author || 'Someone'}: ${String(row.text || '').slice(0, 140)}`;
            const rows = recips.map(u => ({
                user_id: String(u.userid), type: 'yt_comment',
                title: `New YouTube comment on "${String(video.title || '').slice(0, 60)}"`,
                body, from_name: row.author || 'YouTube', is_read: false,
                alert_key: 'ytc:' + row.comment_id
            }));
            await supabase.from('user_notifications').insert(rows);
        }
        await supabase.from('youtube_comments').update({ notified: true }).eq('comment_id', row.comment_id);
    } catch (e) { /* best-effort */ }
}

function ytIdOf(v) {
    return v.source_ref || (String(v.url || '').match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{6,})/) || [])[1] || null;
}

// Poll channel-wide for new comments (cheap: one allThreadsRelatedToChannelId call
// per page), record + notify, schedule AI replies; then post any due AI replies.
export async function pollAndProcessComments() {
    const token = await accessToken();
    if (!token) return { ok: false, error: 'not connected' };
    const channelId = await getConfigValue('YT_ANALYTICS_CHANNEL_ID');
    if (!channelId) return { ok: false, error: 'no channel id — reconnect YouTube in Settings' };

    // Map our course videos by YouTube id.
    const { data: vids } = await supabase.from('course_videos').select('id, title, description, url, source, source_ref').limit(50000);
    const byYt = {}; (vids || []).forEach(v => { const id = ytIdOf(v); if (id) byYt[id] = v; });

    const cfg = await getAiConfig();
    let pageToken = '', pages = 0, newCount = 0;
    do {
        const { ok, j } = await ytDataGet(token, 'commentThreads?part=snippet&order=time&maxResults=100&textFormat=plainText&allThreadsRelatedToChannelId=' + encodeURIComponent(channelId) + (pageToken ? '&pageToken=' + pageToken : ''));
        if (!ok) break;
        let hitKnown = false;
        for (const it of (j.items || [])) {
            const s = it.snippet || {}; const top = s.topLevelComment; const cs = top?.snippet || {};
            const cId = top?.id; const vId = s.videoId;
            if (!cId) continue;
            const v = byYt[vId]; if (!v) continue;                       // not one of our course videos
            const { data: existing } = await supabase.from('youtube_comments').select('id').eq('comment_id', cId).maybeSingle();
            if (existing) { hitKnown = true; continue; }                  // time-ordered → we've caught up
            const authorChannelId = cs.authorChannelId?.value || '';
            const isOwn = authorChannelId && authorChannelId === channelId;
            const row = {
                comment_id: cId, youtube_video_id: vId, course_video_id: v.id,
                author: cs.authorDisplayName || '', text: cs.textOriginal || cs.textDisplay || '',
                published_at: cs.publishedAt || null, ai_status: 'none'
            };
            if (cfg.enabled && cfg.gemini_set && !isOwn) {
                const delayMs = (cfg.min_minutes + Math.random() * (cfg.max_minutes - cfg.min_minutes)) * 60000;
                row.ai_status = 'scheduled';
                row.scheduled_at = new Date(Date.now() + delayMs).toISOString();
            }
            await supabase.from('youtube_comments').insert(row);
            newCount++;
            if (!isOwn) await notifyNewComment(v, row);
        }
        pageToken = j.nextPageToken || ''; pages++;
        if (hitKnown) break;
    } while (pageToken && pages < 5);

    // Post any due AI replies.
    let posted = 0, failed = 0;
    const { data: due } = await supabase.from('youtube_comments')
        .select('*').eq('ai_status', 'scheduled').lte('scheduled_at', new Date().toISOString()).limit(20);
    for (const c of (due || [])) {
        const { data: vv } = await supabase.from('course_videos').select('title, description').eq('id', c.course_video_id).maybeSingle();
        const reply = await generateCommentReply({ author: c.author, text: c.text }, vv || {});
        if (!reply) { await supabase.from('youtube_comments').update({ ai_status: 'error', error: 'AI generation failed' }).eq('id', c.id); failed++; continue; }
        const { ok, j, status } = await ytDataPost(token, 'comments?part=snippet', { snippet: { parentId: c.comment_id, textOriginal: reply } });
        if (ok) {
            await supabase.from('youtube_comments').update({ ai_status: 'posted', ai_reply: reply, replied: true, replied_by: 'ai' }).eq('id', c.id);
            posted++;
            logActivity({ email: 'ai-autoreply', action: `AI replied to a YouTube comment by ${c.author || 'a viewer'}`, category: 'marketing', target_type: 'youtube_comment', target_id: c.comment_id, new_value: { reply } });
        } else {
            await supabase.from('youtube_comments').update({ ai_status: 'error', error: (j?.error?.message || ('HTTP ' + status)) }).eq('id', c.id);
            failed++;
        }
    }
    return { ok: true, new_comments: newCount, ai_posted: posted, ai_failed: failed };
}

// ── Live-chat responder ──────────────────────────────────────────────────────
// Cheap pre-filter: is this worth a host reply at all? (Selectivity, step 1.)
function liveLooksWorthy(t) {
    t = String(t || '').trim();
    if (t.length < 8) return false;
    if (/\?/.test(t)) return true;
    if (/\b(how|what|when|where|why|who|can|could|does|do|is|are|should|which|help|price|cost|support|sign\s?up|join)\b/i.test(t)) return true;
    return false;
}
// Gemini decides skip vs a short reply (Selectivity, step 2 + drafting).
export async function generateLiveChatDecision(msg, video) {
    const key = await geminiKey();
    if (!key) return null;
    try {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0.6, responseMimeType: 'application/json' } });
        const prompt = `You moderate our own PayProTec YouTube LIVE chat, replying as the channel.
Video: "${video?.title || ''}". ${String(video?.description || '').slice(0, 250)}
A live-chat viewer "${msg.author}" wrote: "${String(msg.text || '').slice(0, 250)}"
Decide if this deserves a quick host reply. SKIP greetings, emojis, reactions, spam, or small talk that needs no answer. Reply ONLY to genuine questions or messages directed at us.
Return strict JSON: {"skip":true} to ignore, OR {"skip":false,"reply":"<short friendly reply, max 180 chars, no hashtags, at most one emoji>"}.`;
        const r = await model.generateContent(prompt);
        const j = JSON.parse((r?.response?.text() || '{}').trim());
        if (j.skip || !j.reply) return { skip: true };
        return { skip: false, reply: String(j.reply).slice(0, 190) };
    } catch (e) { return null; }
}

// Poll the active live broadcast's chat until `deadlineMs`, replying selectively.
export async function pollLiveChat(deadlineMs) {
    const cfg = await getAiConfig();
    if (!cfg.live_enabled) return { ok: true, skipped: 'disabled' };
    if (!cfg.gemini_set) return { ok: false, error: 'no Gemini key' };
    const token = await accessToken();
    if (!token) return { ok: false, error: 'not connected' };
    const lb = await ytDataGet(token, 'liveBroadcasts?part=snippet&broadcastStatus=active&broadcastType=all&maxResults=5');
    if (!lb.ok) return { ok: false, error: 'liveBroadcasts failed' };
    const broadcasts = (lb.j.items || []).filter(b => b.snippet?.liveChatId);
    if (!broadcasts.length) return { ok: true, live: false };

    let seen = 0, posted = 0;
    for (const b of broadcasts) {
        const liveChatId = b.snippet.liveChatId;
        const { data: cv } = await supabase.from('course_videos').select('id, title, description').eq('source_ref', b.id).maybeSingle();
        const video = cv || { title: b.snippet.title, description: b.snippet.description };
        const { data: stRow } = await supabase.from('youtube_livechat_state').select('page_token').eq('live_chat_id', liveChatId).maybeSingle();
        let pageToken = stRow?.page_token || '';

        while (Date.now() < deadlineMs) {
            const { ok, j } = await ytDataGet(token, 'liveChat/messages?part=snippet,authorDetails&maxResults=200&liveChatId=' + encodeURIComponent(liveChatId) + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''));
            if (!ok) break;
            pageToken = j.nextPageToken || pageToken;
            for (const it of (j.items || [])) {
                try {
                    const sn = it.snippet || {}; const ad = it.authorDetails || {};
                    if (sn.type !== 'textMessageEvent') continue;
                    if (ad.isChatOwner) continue;                            // never reply to ourselves
                    const mid = it.id;
                    const text = sn.displayMessage || sn.textMessageDetails?.messageText || '';
                    const { data: ex } = await supabase.from('youtube_livechat').select('id').eq('message_id', mid).maybeSingle();
                    if (ex) continue;
                    seen++;
                    const base = { live_chat_id: liveChatId, message_id: mid, author: ad.displayName || '', text };
                    // Step 1 — cheap selectivity filter.
                    if (cfg.live_questions_only && !liveLooksWorthy(text)) {
                        await supabase.from('youtube_livechat').insert({ ...base, status: 'skipped' }); continue;
                    }
                    // Throttle — max replies/minute.
                    const sinceIso = new Date(Date.now() - 60000).toISOString();
                    const { count } = await supabase.from('youtube_livechat').select('id', { count: 'exact', head: true }).eq('replied', true).gte('detected_at', sinceIso);
                    if ((count || 0) >= cfg.live_max_per_min) {
                        await supabase.from('youtube_livechat').insert({ ...base, status: 'skipped', error: 'rate_limited' }); continue;
                    }
                    // Step 2 — Gemini decides + drafts.
                    const dec = await generateLiveChatDecision({ author: ad.displayName, text }, video);
                    if (!dec || dec.skip || !dec.reply) {
                        await supabase.from('youtube_livechat').insert({ ...base, status: 'skipped' }); continue;
                    }
                    // Stagger with a small random delay (human-like).
                    const jitter = (cfg.live_delay_min_sec + Math.random() * (cfg.live_delay_max_sec - cfg.live_delay_min_sec)) * 1000;
                    if (Date.now() + jitter + 2000 > deadlineMs) {           // not enough time — leave for next run
                        await supabase.from('youtube_livechat').insert({ ...base, status: 'seen' }); continue;
                    }
                    await sleep(jitter);
                    const reply = dec.reply.slice(0, 190);
                    const ins = await ytDataPost(token, 'liveChat/messages?part=snippet', { snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: reply } } });
                    if (ins.ok) {
                        await supabase.from('youtube_livechat').insert({ ...base, status: 'replied', replied: true, ai_reply: reply }); posted++;
                    } else {
                        await supabase.from('youtube_livechat').insert({ ...base, status: 'error', error: ins.j?.error?.message || 'post failed' });
                    }
                } catch (e) { /* skip this message, keep polling */ }
            }
            await supabase.from('youtube_livechat_state').upsert({ live_chat_id: liveChatId, page_token: pageToken, updated_at: new Date().toISOString() }, { onConflict: 'live_chat_id' });
            const wait = Math.min(Math.max(j.pollingIntervalMillis || 6000, 4000), 12000);
            if (Date.now() + wait >= deadlineMs) break;
            await sleep(wait);
        }
    }
    return { ok: true, live: true, seen, posted };
}

// Refresh portal-attributed views for every YouTube-backed video.
export async function refreshPortalYtStats() {
    const token = await accessToken();
    if (!token) return { ok: false, error: 'YouTube channel not connected.', updated: 0 };
    const hosts = await portalHosts();
    const endDate = new Date().toISOString().slice(0, 10);
    const { data: vids } = await supabase.from('course_videos').select('id, url, source, source_ref').limit(50000);
    const yt = (vids || []).filter(v => v.source === 'youtube' || ytVideoId(v));
    let updated = 0;
    const now = new Date().toISOString();
    // Small concurrency pool (Analytics API is per-video; be gentle on quota).
    const POOL = 4;
    for (let i = 0; i < yt.length; i += POOL) {
        const batch = yt.slice(i, i + POOL);
        await Promise.all(batch.map(async (v) => {
            const id = ytVideoId(v);
            if (!id) return;
            const n = await portalViewsForVideo(token, id, hosts, endDate);
            if (n == null) return;
            await supabase.from('course_videos').update({ yt_portal_views: n, yt_portal_views_at: now }).eq('id', v.id);
            updated++;
        }));
    }
    return { ok: true, updated };
}

// These are sensitive integration settings — require the granular
// Marketing → Settings access (not just broad marketing access).
async function requireStaff(req, res) {
    const session = await validateSession(req);
    if (!session) { bad(res, 'Unauthorized', 401); return null; }
    const actor = await loadActor(session.userid);
    if (!canMarketingSettings(actor)) { bad(res, 'Access denied. Marketing Settings access required.', 403); return null; }
    session._actor = actor;
    return session;
}
// Reading/replying to comments is an operational marketing action (not settings).
async function requireMarketing(req, res) {
    const session = await validateSession(req);
    if (!session) { bad(res, 'Unauthorized', 401); return null; }
    const actor = await loadActor(session.userid);
    if (!canMarketing(actor)) { bad(res, 'Access denied. Marketing access required.', 403); return null; }
    session._actor = actor;
    return session;
}
// Resolve a YouTube video id from one of our course_videos rows.
async function resolveYtId(body) {
    if (body.youtube_id) return String(body.youtube_id);
    if (!body.video_id) return null;
    const { data: v } = await supabase.from('course_videos').select('url, source_ref').eq('id', body.video_id).maybeSingle();
    if (!v) return null;
    return v.source_ref || (String(v.url || '').match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([\w-]{6,})/) || [])[1] || null;
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    try {
        // ── OAuth callback (Google redirects here after consent) ──
        if (req.method === 'GET' && (req.query.code || req.query.error)) {
            const backOk = '/marketing-settings?yt=connected';
            const backErr = (m) => '/marketing-settings?yt=error&msg=' + encodeURIComponent(m || 'failed');
            if (req.query.error) return res.redirect(302, backErr(String(req.query.error)));
            const savedState = await getConfigValue('YT_OAUTH_STATE');
            if (!savedState || savedState !== req.query.state) return res.redirect(302, backErr('state mismatch'));
            const { id, secret } = await clientCreds();
            if (!id || !secret) return res.redirect(302, backErr('client not configured'));
            const r = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code: String(req.query.code), client_id: id, client_secret: secret,
                    redirect_uri: redirectUri(req), grant_type: 'authorization_code'
                }).toString()
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.refresh_token) {
                // No refresh_token usually means consent wasn't forced — retry needs prompt=consent (we set it).
                return res.redirect(302, backErr(j.error_description || j.error || 'no refresh token'));
            }
            await setConfigValue('YT_OAUTH_REFRESH_TOKEN', j.refresh_token, 'youtube-oauth');
            await setConfigValue('YT_OAUTH_SCOPES', j.scope || '', 'youtube-oauth');
            await setConfigValue('YT_OAUTH_STATE', '', 'youtube-oauth');
            // Best-effort: store the channel title for display.
            try {
                const cr = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + j.access_token } });
                const cj = await cr.json().catch(() => ({}));
                const item = cj?.items?.[0];
                if (item?.snippet?.title) await setConfigValue('YT_ANALYTICS_CHANNEL', item.snippet.title, 'youtube-oauth');
                if (item?.id) await setConfigValue('YT_ANALYTICS_CHANNEL_ID', item.id, 'youtube-oauth');   // for channel-wide comment polling
            } catch { /* ignore */ }
            logActivity({ email: 'youtube-oauth', action: 'YouTube Analytics channel connected via OAuth', category: 'marketing', target_type: 'marketing_setting', target_id: 'yt_analytics' }, req);
            return res.redirect(302, backOk);
        }

        // ── POST actions (staff + marketing) ──
        const body = req.method === 'GET' ? (req.query || {}) : (req.body || {});
        const action = body.action;

        if (action === 'status') {
            const session = await requireStaff(req, res); if (!session) return;
            const { id, secret } = await clientCreds();
            const refresh = await getConfigValue('YT_OAUTH_REFRESH_TOKEN');
            return ok(res, {
                client_set: !!(id && secret),
                connected: !!refresh,
                can_reply: await ytHasCommentScope(),
                channel: (await getConfigValue('YT_ANALYTICS_CHANNEL')) || '',
                hosts: (await portalHosts()).join(', '),
                redirect_uri: redirectUri(req)
            });
        }
        if (action === 'set_client') {
            const session = await requireStaff(req, res); if (!session) return;
            if (body.client_id) await setConfigValue('YT_OAUTH_CLIENT_ID', String(body.client_id).trim(), session.userid);
            if (body.client_secret) await setConfigValue('YT_OAUTH_CLIENT_SECRET', String(body.client_secret).trim(), session.userid);
            const { id, secret } = await clientCreds();
            logActivity({ email: session._actor?.email || session.userid, action: `${actorName(session._actor)} updated YouTube Analytics OAuth client credentials`, category: 'marketing', target_type: 'marketing_setting', target_id: 'yt_oauth_client' }, req);
            return ok(res, { client_set: !!(id && secret) });
        }
        if (action === 'set_hosts') {
            const session = await requireStaff(req, res); if (!session) return;
            await setConfigValue('YT_PORTAL_HOSTS', String(body.hosts || '').trim() || 'portal.mypayprotec.com', session.userid);
            logActivity({ email: session._actor?.email || session.userid, action: `${actorName(session._actor)} set YouTube portal-attribution hosts`, category: 'marketing', target_type: 'marketing_setting', target_id: 'yt_portal_hosts', new_value: { hosts: body.hosts } }, req);
            return ok(res, { hosts: (await portalHosts()).join(', ') });
        }
        if (action === 'start') {
            const session = await requireStaff(req, res); if (!session) return;
            const { id, secret } = await clientCreds();
            if (!id || !secret) return bad(res, 'Add the Google OAuth client ID + secret first.');
            // Random state (verified on callback). Uses Web Crypto (available in the runtime).
            const state = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
            await setConfigValue('YT_OAUTH_STATE', state, session.userid);
            const params = new URLSearchParams({
                client_id: id, redirect_uri: redirectUri(req), response_type: 'code',
                scope: SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state
            });
            return ok(res, { auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
        }
        if (action === 'disconnect') {
            const session = await requireStaff(req, res); if (!session) return;
            await setConfigValue('YT_OAUTH_REFRESH_TOKEN', '', session.userid);
            await setConfigValue('YT_ANALYTICS_CHANNEL', '', session.userid);
            logActivity({ email: session._actor?.email || session.userid, action: `${actorName(session._actor)} disconnected the YouTube Analytics channel`, category: 'marketing', severity: 'warning', target_type: 'marketing_setting', target_id: 'yt_analytics' }, req);
            return ok(res, { connected: false });
        }
        if (action === 'refresh_portal_views') {
            const session = await requireStaff(req, res); if (!session) return;
            const r = await refreshPortalYtStats();
            if (!r.ok) return bad(res, r.error || 'Refresh failed');
            logActivity({ email: session._actor?.email || session.userid, action: `${actorName(session._actor)} refreshed portal-attributed YouTube views (${r.updated} videos)`, category: 'marketing', target_type: 'marketing_setting', target_id: 'yt_portal_views' }, req);
            return ok(res, r);
        }

        // ── AI auto-reply config (Marketing Settings) ──
        if (action === 'get_ai_config') {
            const session = await requireStaff(req, res); if (!session) return;
            return ok(res, await getAiConfig());
        }
        if (action === 'set_ai_config') {
            const session = await requireStaff(req, res); if (!session) return;
            let mn = parseInt(body.min_minutes, 10); if (!Number.isFinite(mn) || mn < 1) mn = 1; mn = Math.min(mn, 120);
            let mx = parseInt(body.max_minutes, 10); if (!Number.isFinite(mx) || mx < mn) mx = Math.max(mn, 10); mx = Math.min(mx, 120);
            await setConfigValue('YT_AI_AUTOREPLY_ENABLED', body.enabled ? 'true' : 'false', session.userid);
            await setConfigValue('YT_AI_DELAY_MIN', String(mn), session.userid);
            await setConfigValue('YT_AI_DELAY_MAX', String(mx), session.userid);
            logActivity({ email: session._actor?.email || session.userid, action: `${actorName(session._actor)} ${body.enabled ? 'enabled' : 'disabled'} YouTube AI auto-reply (${mn}–${mx} min delay)`, category: 'marketing', target_type: 'marketing_setting', target_id: 'yt_ai_autoreply', new_value: { enabled: !!body.enabled, min: mn, max: mx } }, req);
            return ok(res, await getAiConfig());
        }
        if (action === 'set_live_config') {
            const session = await requireStaff(req, res); if (!session) return;
            const mpm = clampInt(body.max_per_min, 1, 30, 4);
            const dmin = clampInt(body.delay_min_sec, 0, 120, 3);
            const dmax = Math.max(dmin, clampInt(body.delay_max_sec, 0, 300, 20));
            await setConfigValue('YT_LIVE_ENABLED', body.enabled ? 'true' : 'false', session.userid);
            await setConfigValue('YT_LIVE_MAX_PM', String(mpm), session.userid);
            await setConfigValue('YT_LIVE_DELAY_MIN', String(dmin), session.userid);
            await setConfigValue('YT_LIVE_DELAY_MAX', String(dmax), session.userid);
            await setConfigValue('YT_LIVE_QONLY', body.questions_only ? 'true' : 'false', session.userid);
            logActivity({ email: session._actor?.email || session.userid, action: `${actorName(session._actor)} ${body.enabled ? 'enabled' : 'disabled'} YouTube live-chat AI responder (max ${mpm}/min, ${dmin}-${dmax}s)`, category: 'marketing', target_type: 'marketing_setting', target_id: 'yt_livechat_ai' }, req);
            return ok(res, await getAiConfig());
        }
        // Draft an AI reply for a single comment (does NOT post).
        if (action === 'ai_draft') {
            const session = await requireMarketing(req, res); if (!session) return;
            let video = { title: body.title || '', description: body.description || '' };
            if (body.video_id) {
                const { data: v } = await supabase.from('course_videos').select('title, description').eq('id', body.video_id).maybeSingle();
                if (v) video = v;
            }
            const draft = await generateCommentReply({ author: body.author || '', text: body.text || '' }, video);
            if (!draft) return bad(res, 'Could not generate a draft (check the Gemini API key).');
            return ok(res, { draft });
        }

        // ── YouTube comments (read + reply as the channel) ──
        if (action === 'list_comments') {
            const session = await requireMarketing(req, res); if (!session) return;
            const token = await accessToken();
            if (!token) return bad(res, 'YouTube channel not connected.');
            const ytid = await resolveYtId(body);
            if (!ytid) return bad(res, 'Not a YouTube video');
            const { ok: okr, status, j } = await ytDataGet(token, 'commentThreads?part=snippet,replies&maxResults=50&order=time&textFormat=plainText&videoId=' + encodeURIComponent(ytid));
            if (!okr) {
                const reason = j?.error?.errors?.[0]?.reason || '';
                if (reason === 'commentsDisabled') return ok(res, { disabled: true, threads: [], can_reply: await ytHasCommentScope() });
                return bad(res, j?.error?.message || ('HTTP ' + status));
            }
            const threads = (j.items || []).map(it => {
                const top = it.snippet?.topLevelComment; const s = top?.snippet || {};
                const replies = (it.replies?.comments || []).map(c => ({
                    id: c.id, author: c.snippet?.authorDisplayName || '', text: c.snippet?.textDisplay || c.snippet?.textOriginal || '',
                    at: c.snippet?.publishedAt || null
                }));
                return {
                    id: top?.id, author: s.authorDisplayName || '', authorImage: s.authorProfileImageUrl || '',
                    text: s.textDisplay || s.textOriginal || '', likeCount: s.likeCount || 0, at: s.publishedAt || null,
                    totalReplies: it.snippet?.totalReplyCount || 0, replies
                };
            });
            return ok(res, { disabled: false, threads, can_reply: await ytHasCommentScope() });
        }
        if (action === 'reply_comment') {
            const session = await requireMarketing(req, res); if (!session) return;
            const token = await accessToken();
            if (!token) return bad(res, 'YouTube channel not connected.');
            const parentId = String(body.parent_id || '').trim();
            const text = String(body.text || '').trim();
            if (!parentId || !text) return bad(res, 'parent_id and text required');
            if (!(await ytHasCommentScope())) return bad(res, 'Replying needs the comment permission — reconnect YouTube in Settings to enable it.', 403);
            const { ok: okr, status, j } = await ytDataPost(token, 'comments?part=snippet', { snippet: { parentId, textOriginal: text } });
            if (!okr) {
                const reason = j?.error?.errors?.[0]?.reason || '';
                if (status === 403 || reason === 'insufficientPermissions' || reason === 'forbidden')
                    return bad(res, 'Replying needs the comment permission — reconnect YouTube in Settings to enable it.', 403);
                return bad(res, j?.error?.message || ('HTTP ' + status));
            }
            logActivity({ email: session._actor?.email || session.userid, action: `${actorName(session._actor)} replied to a YouTube comment`, category: 'marketing', target_type: 'youtube_comment', target_id: parentId, new_value: { text } }, req);
            const c = j?.snippet || {};
            return ok(res, { reply: { id: j?.id, author: c.authorDisplayName || '', text: c.textDisplay || c.textOriginal || text, at: c.publishedAt || null } });
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
