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

// Post a possibly-long markdown message, splitting into multiple messages at line
// boundaries so nothing is truncated (ClickUp caps a single message ~20k chars).
export async function cuPostLong(workspaceId, channelId, markdown, limit = 18000) {
    const text = String(markdown || '');
    if (text.length <= limit) return cuPostMessage(workspaceId, channelId, text);
    const lines = text.split('\n');
    const chunks = [];
    let buf = '';
    for (const line of lines) {
        // A single over-long line is hard-split as a last resort.
        if (line.length > limit) {
            if (buf) { chunks.push(buf); buf = ''; }
            for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
            continue;
        }
        if ((buf + '\n' + line).length > limit) { chunks.push(buf); buf = line; }
        else { buf = buf ? (buf + '\n' + line) : line; }
    }
    if (buf) chunks.push(buf);
    let ok = true, error = null;
    for (let i = 0; i < chunks.length; i++) {
        const head = chunks.length > 1 ? `_(part ${i + 1}/${chunks.length})_\n` : '';
        const r = await cuPostMessage(workspaceId, channelId, head + chunks[i]);
        if (!r.ok) { ok = false; error = r.error; break; }
    }
    return { ok, error, parts: chunks.length };
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
