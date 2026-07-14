// Webflow v2 connector helpers. Centralized custom-code injection so the portal
// can push the announcement loader to selected sites without manual pasting.
//
// Auth: an OAuth access token stored (encrypted) in app_config as
// WEBFLOW_ACCESS_TOKEN. The app's Client ID/Secret live in Vercel env
// (WEBFLOW_CLIENT_ID / WEBFLOW_CLIENT_SECRET).
import { getConfigValue, setConfigValue } from './api-config.js';

const WF_API = 'https://api.webflow.com/v2';
const OAUTH_AUTHORIZE = 'https://webflow.com/oauth/authorize';
const OAUTH_TOKEN = 'https://api.webflow.com/oauth/access_token';
const SCOPES = 'sites:read sites:write custom_code:read custom_code:write authorized_user:read';

export function webflowConfigured() { return !!(process.env.WEBFLOW_CLIENT_ID && process.env.WEBFLOW_CLIENT_SECRET); }

export async function getToken() { return (await getConfigValue('WEBFLOW_ACCESS_TOKEN')) || null; }

export function authorizeUrl(redirectUri, state) {
    const p = new URLSearchParams({
        response_type: 'code', client_id: process.env.WEBFLOW_CLIENT_ID || '',
        redirect_uri: redirectUri, scope: SCOPES, state
    });
    return `${OAUTH_AUTHORIZE}?${p.toString()}`;
}

// Exchange an OAuth code for an access token and persist it.
export async function exchangeCode(code, redirectUri) {
    const r = await fetch(OAUTH_TOKEN, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            client_id: process.env.WEBFLOW_CLIENT_ID, client_secret: process.env.WEBFLOW_CLIENT_SECRET,
            code, grant_type: 'authorization_code', redirect_uri: redirectUri
        })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) throw new Error(data.message || ('Token exchange failed (' + r.status + ')'));
    await setConfigValue('WEBFLOW_ACCESS_TOKEN', data.access_token, 'webflow-oauth');
    return data.access_token;
}

async function wf(path, opts = {}) {
    const token = await getToken();
    if (!token) throw new Error('Webflow not connected');
    const r = await fetch(WF_API + path, {
        ...opts,
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json', ...(opts.headers || {}) }
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || (path + ' failed (' + r.status + ')'));
    return data;
}

// List all sites the connected workspace/token can access.
export async function listSites() {
    const data = await wf('/sites');
    return (data.sites || []).map(s => ({ id: s.id, name: s.displayName || s.shortName || s.id, shortName: s.shortName }));
}

// Register an inline script on a site (idempotent-ish: Webflow versions scripts).
export async function registerInlineScript(siteId, sourceCode, displayName, version) {
    const data = await wf(`/sites/${siteId}/registered_scripts/inline`, {
        method: 'POST', body: JSON.stringify({ sourceCode, version, displayName })
    });
    return data.id || data.script?.id || null;
}

// Apply a registered script to the site footer.
export async function applyFooterScript(siteId, scriptId, version) {
    return wf(`/sites/${siteId}/custom_code`, {
        method: 'PUT', body: JSON.stringify({ scripts: [{ id: scriptId, location: 'footer', version }] })
    });
}

// Remove all portal-applied custom code from a site.
export async function clearCustomCode(siteId) {
    return wf(`/sites/${siteId}/custom_code`, { method: 'PUT', body: JSON.stringify({ scripts: [] }) });
}

// Publish the site so injected/removed code goes live.
export async function publishSite(siteId) {
    try { return await wf(`/sites/${siteId}/publish`, { method: 'POST', body: JSON.stringify({ publishToWebflowSubdomain: true }) }); }
    catch (e) { return { published: false, message: e.message }; }
}

export async function disconnect() { await setConfigValue('WEBFLOW_ACCESS_TOKEN', '', 'webflow-oauth'); }
