// ── ClickUp Chat integration ─────────────────────────────────────────────────
// Post reports/stats into a ClickUp Chat channel. Auth = a ClickUp API token
// (personal pk_… token or OAuth access token), stored encrypted in app_config as
// CLICKUP_API_TOKEN (env override supported), matching the other secrets.
//
// Endpoints used:
//   GET  /api/v2/team                                             → workspaces
//   GET  /api/v3/workspaces/{wid}/chat/channels                   → chat channels
//   POST /api/v3/workspaces/{wid}/chat/channels/{cid}/messages    → send a message
import { getConfigValue } from './api-config.js';

const CU_BASE = 'https://api.clickup.com/api';

export async function getClickUpToken() {
    return process.env.CLICKUP_API_TOKEN || (await getConfigValue('CLICKUP_API_TOKEN')) || null;
}
export async function clickUpConfigured() {
    return !!(await getClickUpToken());
}

function cuHeaders(token) {
    return { 'Authorization': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

// List the workspaces (teams) the token can see → [{id, name}].
export async function cuListWorkspaces() {
    const token = await getClickUpToken();
    if (!token) return { ok: false, error: 'no token', workspaces: [] };
    try {
        const r = await fetch(`${CU_BASE}/v2/team`, { headers: cuHeaders(token) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, error: j?.err || ('HTTP ' + r.status), workspaces: [] };
        const workspaces = (j.teams || []).map(t => ({ id: String(t.id), name: t.name || String(t.id) }));
        return { ok: true, workspaces };
    } catch (e) { return { ok: false, error: e.message, workspaces: [] }; }
}

// List Chat channels in a workspace → [{id, name}] (follows pagination).
export async function cuListChannels(workspaceId) {
    const token = await getClickUpToken();
    if (!token) return { ok: false, error: 'no token', channels: [] };
    if (!workspaceId) return { ok: false, error: 'no workspace', channels: [] };
    try {
        const channels = [];
        let cursor = '';
        for (let i = 0; i < 20; i++) {   // hard cap the pagination loop
            const url = `${CU_BASE}/v3/workspaces/${encodeURIComponent(workspaceId)}/chat/channels?limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
            const r = await fetch(url, { headers: cuHeaders(token) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) return { ok: false, error: j?.err || j?.message || ('HTTP ' + r.status), channels };
            const list = j.data || j.channels || [];
            list.forEach(c => channels.push({ id: String(c.id), name: c.name || c.topic || String(c.id) }));
            cursor = j.next_cursor || j.cursor || '';
            if (!cursor || !list.length) break;
        }
        return { ok: true, channels };
    } catch (e) { return { ok: false, error: e.message, channels: [] }; }
}

// Post a markdown message into a Chat channel.
export async function cuPostMessage(workspaceId, channelId, markdown) {
    const token = await getClickUpToken();
    if (!token) return { ok: false, error: 'no token' };
    if (!workspaceId || !channelId) return { ok: false, error: 'missing workspace/channel' };
    try {
        const r = await fetch(`${CU_BASE}/v3/workspaces/${encodeURIComponent(workspaceId)}/chat/channels/${encodeURIComponent(channelId)}/messages`, {
            method: 'POST',
            headers: cuHeaders(token),
            body: JSON.stringify({ type: 'message', content_format: 'text/md', content: String(markdown || '').slice(0, 20000) })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, error: j?.err || j?.message || ('HTTP ' + r.status) };
        return { ok: true, id: j?.data?.id || j?.id || null };
    } catch (e) { return { ok: false, error: e.message }; }
}
