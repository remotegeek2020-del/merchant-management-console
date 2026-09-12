// ── Website bot — HighLevel Custom Conversation Provider (OAuth) ────────────
// This is a SEPARATE auth mechanism from the rest of api/_ghl.js: that file
// uses per-location Private Integration tokens; a Marketplace App's Custom
// Conversation Provider requires a real OAuth 2.0 install (authorization
// code -> access/refresh token), because logging messages under a
// conversationProviderId is scoped to the app's own OAuth grant, not a
// location's Private Integration token.
//
// Sourced directly from HighLevel's own API spec (not guessed):
//   Authorize: https://marketplace.gohighlevel.com/oauth/chooselocation
//   Token:     https://services.leadconnectorhq.com/oauth/token
//   Messages:  POST /conversations/messages/inbound | /conversations/messages/outbound
import { getConfigValue, setConfigValue } from './api-config.js';

const OAUTH_TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';
const API_BASE = 'https://services.leadconnectorhq.com';
const TOKENS_KEY = 'GHL_BOT_PROVIDER_TOKENS'; // JSON blob: access_token, refresh_token, expires_at, location_id, company_id

export function providerRedirectUri(req) {
    // Must exactly match what's registered in the Marketplace App's Auth section.
    return process.env.BOT_PROVIDER_REDIRECT_URI || 'https://portal.mypayprotec.com/api/bot-oauth-callback';
}

export async function providerAuthUrl(req) {
    const clientId = await getConfigValue('GHL_BOT_CLIENT_ID');
    if (!clientId) return null;
    const scope = encodeURIComponent('conversations/message.readonly conversations/message.write conversations.readonly conversations.write contacts.readonly contacts.write');
    const redirect = encodeURIComponent(providerRedirectUri(req));
    return `https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&redirect_uri=${redirect}&client_id=${encodeURIComponent(clientId)}&scope=${scope}`;
}

async function exchangeCodeForTokens(code, req) {
    const clientId = await getConfigValue('GHL_BOT_CLIENT_ID');
    const clientSecret = await getConfigValue('GHL_BOT_CLIENT_SECRET');
    if (!clientId || !clientSecret) return { ok: false, error: 'GHL_BOT_CLIENT_ID/SECRET not configured' };
    const body = new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
        code, redirect_uri: providerRedirectUri(req)
    });
    const r = await fetch(OAUTH_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.access_token) return { ok: false, error: j?.message || ('HTTP ' + r.status) };
    return { ok: true, tokens: j };
}

async function refreshTokens(refreshToken) {
    const clientId = await getConfigValue('GHL_BOT_CLIENT_ID');
    const clientSecret = await getConfigValue('GHL_BOT_CLIENT_SECRET');
    if (!clientId || !clientSecret) return { ok: false, error: 'GHL_BOT_CLIENT_ID/SECRET not configured' };
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken });
    const r = await fetch(OAUTH_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.access_token) return { ok: false, error: j?.message || ('HTTP ' + r.status) };
    return { ok: true, tokens: j };
}

// Persists whatever the token endpoint returns — a fresh refresh_token
// always overwrites the stored one (safe whether or not GHL rotates it).
async function saveTokens(tokens) {
    const record = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        location_id: tokens.locationId || null,
        company_id: tokens.companyId || null
    };
    await setConfigValue(TOKENS_KEY, JSON.stringify(record), 'bot-provider-oauth');
    return record;
}

export async function completeInstall(code, req) {
    const r = await exchangeCodeForTokens(code, req);
    if (!r.ok) return r;
    const record = await saveTokens(r.tokens);
    return { ok: true, record };
}

// Returns a currently-valid access token, refreshing if it's expired or
// close to it. Returns null if never installed or refresh fails.
export async function getValidAccessToken() {
    const raw = await getConfigValue(TOKENS_KEY);
    if (!raw) return null;
    let record; try { record = JSON.parse(raw); } catch { return null; }
    if (!record.access_token) return null;
    if (record.expires_at && record.expires_at - Date.now() > 5 * 60 * 1000) return record;
    if (!record.refresh_token) return null;
    const r = await refreshTokens(record.refresh_token);
    if (!r.ok) { console.error('[bot-ghl-provider] refresh failed:', r.error); return null; }
    return await saveTokens(r.tokens);
}

// Logs one message (inbound = from the visitor, outbound = from the bot)
// into the Custom Conversation Provider channel so it shows in HighLevel's
// Conversations tab for that contact, without sending a real SMS/email.
export async function logProviderMessage({ contactId, direction, body }) {
    const tok = await getValidAccessToken();
    if (!tok) return { ok: false, error: 'HighLevel Conversation Provider is not connected yet.' };
    const conversationProviderId = await getConfigValue('GHL_BOT_CONVO_PROVIDER_ID');
    if (!conversationProviderId) return { ok: false, error: 'GHL_BOT_CONVO_PROVIDER_ID not configured' };
    const path = direction === 'outbound' ? '/conversations/messages/outbound' : '/conversations/messages/inbound';
    try {
        const r = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${tok.access_token}`, 'Version': '2021-04-15', 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                type: 'SMS', contactId, locationId: tok.location_id || undefined,
                conversationProviderId, direction, message: body, body
            })
        });
        const j = await r.json().catch(() => null);
        if (!r.ok) console.error('[bot-ghl-provider] log message failed:', r.status, JSON.stringify(j));
        return { ok: r.ok, id: j?.id || null, error: r.ok ? null : (j?.message || ('HTTP ' + r.status)) };
    } catch (e) { return { ok: false, error: e.message }; }
}
