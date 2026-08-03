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

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SCOPES = [
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'https://www.googleapis.com/auth/youtube.readonly'
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

async function requireStaff(req, res) {
    const session = await validateSession(req);
    if (!session) { bad(res, 'Unauthorized', 401); return null; }
    const { data: actor } = await supabase.from('app_users').select('role, access_marketing').eq('userid', session.userid).maybeSingle();
    const role = String(actor?.role || '').toLowerCase();
    const canMarketing = role.includes('super') || role.includes('admin') || actor?.access_marketing === true;
    if (!canMarketing) { bad(res, 'Access denied. Marketing access required.', 403); return null; }
    return session;
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();

    try {
        // ── OAuth callback (Google redirects here after consent) ──
        if (req.method === 'GET' && (req.query.code || req.query.error)) {
            const backOk = '/marketing-courses?yt=connected';
            const backErr = (m) => '/marketing-courses?yt=error&msg=' + encodeURIComponent(m || 'failed');
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
            await setConfigValue('YT_OAUTH_STATE', '', 'youtube-oauth');
            // Best-effort: store the channel title for display.
            try {
                const cr = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + j.access_token } });
                const cj = await cr.json().catch(() => ({}));
                const title = cj?.items?.[0]?.snippet?.title;
                if (title) await setConfigValue('YT_ANALYTICS_CHANNEL', title, 'youtube-oauth');
            } catch { /* ignore */ }
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
            return ok(res, { client_set: !!(id && secret) });
        }
        if (action === 'set_hosts') {
            const session = await requireStaff(req, res); if (!session) return;
            await setConfigValue('YT_PORTAL_HOSTS', String(body.hosts || '').trim() || 'portal.mypayprotec.com', session.userid);
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
            return ok(res, { connected: false });
        }
        if (action === 'refresh_portal_views') {
            const session = await requireStaff(req, res); if (!session) return;
            const r = await refreshPortalYtStats();
            if (!r.ok) return bad(res, r.error || 'Refresh failed');
            return ok(res, r);
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        return bad(res, 'Server error: ' + (e.message || 'unknown'), 500);
    }
}
