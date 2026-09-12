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

// Raw connection diagnostics for the "Send test message" button in
// bot-manager.html — surfaces exactly what's missing rather than making the
// admin guess between "not connected" / "no provider ID" / "bad token".
// HighLevel's OAuth access tokens are JWTs — decode (not verify; we don't
// need to, we're just reading our own token's claims) the payload so
// diagnostics can show the REAL scopes/authClass HighLevel granted, instead
// of only what we asked for. A stale/under-scoped token is invisible from
// the outside otherwise.
function decodeJwtPayload(token) {
    try {
        const part = String(token || '').split('.')[1];
        if (!part) return null;
        const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        return JSON.parse(json);
    } catch { return null; }
}

export async function providerDiagnostics() {
    const clientId = await getConfigValue('GHL_BOT_CLIENT_ID');
    const clientSecret = await getConfigValue('GHL_BOT_CLIENT_SECRET');
    const providerId = await getConfigValue('GHL_BOT_CONVO_PROVIDER_ID');
    const tok = await getValidAccessToken();
    const claims = tok ? decodeJwtPayload(tok.access_token) : null;
    return {
        client_configured: !!(clientId && clientSecret),
        provider_id_configured: !!providerId,
        provider_id: providerId || null,
        connected: !!tok,
        location_id: tok?.location_id || null,
        token_auth_class: claims?.authClass || null,
        token_auth_class_id: claims?.authClassId || null,
        token_scopes: claims?.oauthMeta?.scopes || claims?.scopes || null,
        token_client_id: claims?.client_id || claims?.clientKey || null,
        // Full claim key list + a couple of likely app-identity fields, so we
        // can see whatever this token ACTUALLY carries instead of guessing
        // key names — one of these should reveal which Marketplace App this
        // token really belongs to.
        token_claim_keys: claims ? Object.keys(claims) : null,
        token_claims_raw: claims || null
    };
}

// Logs one message (inbound = from the visitor, outbound = from the bot)
// into the Custom Conversation Provider channel so it shows in HighLevel's
// Conversations tab for that contact, without sending a real SMS/email.
export async function logProviderMessage({ contactId, direction, body, conversationId }) {
    const tok = await getValidAccessToken();
    if (!tok) return { ok: false, error: 'HighLevel Conversation Provider is not connected yet.' };
    const conversationProviderId = await getConfigValue('GHL_BOT_CONVO_PROVIDER_ID');
    if (!conversationProviderId) return { ok: false, error: 'GHL_BOT_CONVO_PROVIDER_ID not configured' };
    // Verified against HighLevel's own published OpenAPI spec
    // (ProcessMessageBodyDto, POST /conversations/messages/inbound):
    // required fields are exactly type + conversationId + contactId +
    // conversationProviderId. conversationId is REQUIRED — sending it as
    // undefined silently drops the key from the JSON body, which is almost
    // certainly what produced the "Incorrect conversationProviderId/type"
    // error every earlier attempt hit (HighLevel's validator folds a missing
    // required field into that same generic message). There is no
    // "/conversations/messages/outbound" for SMS-type providers — that path
    // is Call-log-only (its schema's "type" enum is literally just "Call").
    if (!conversationId) return { ok: false, error: 'No conversationId resolved for this contact — cannot log without one.' };
    const payload = {
        type: 'SMS', contactId, conversationId, conversationProviderId,
        direction: direction === 'outbound' ? 'outbound' : 'inbound',
        message: body
    };
    async function attempt(versionHeader) {
        const r = await fetch(`${API_BASE}/conversations/messages/inbound`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${tok.access_token}`, 'Version': versionHeader, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(payload)
        });
        const j = await r.json().catch(() => null);
        return { ok: r.ok, status: r.status, id: j?.messageId || j?.id || null, error: r.ok ? null : (j?.message || ('HTTP ' + r.status)) };
    }
    try {
        // Same documented DTO exists under both the legacy dated version and
        // the newer "v3" version header — try v3 first (this app was created
        // today, so it's plausibly the version actually wired up for new
        // apps' conversation providers on HighLevel's backend), falling back
        // to the legacy version if v3 itself is rejected outright.
        let res = await attempt('v3');
        if (!res.ok && res.status === 400) {
            const legacy = await attempt('2021-04-15');
            if (legacy.ok) return legacy;
            console.error('[bot-ghl-provider] log message failed (both versions):', res.status, res.error, '|', legacy.status, legacy.error);
            return res.ok ? res : legacy;
        }
        if (!res.ok) console.error('[bot-ghl-provider] log message failed:', res.status, res.error);
        return res;
    } catch (e) { return { ok: false, error: e.message }; }
}
