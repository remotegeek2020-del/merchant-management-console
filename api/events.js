// ── EVENTS / SHOWS DASHBOARD API (staff) ─────────────────────────────────────
// Multi-channel event tracking: contacts arrive via the HL webhook (event-intake),
// CSV import, or GHL tag backfill — each tagged with a channel. Gated on staff
// session + access_marketing (super_admin / admin always allowed).
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { validateSession as validateStaff, sessionErrorResponse } from './_validate.js';
import { getConfigValue, setConfigValue } from './api-config.js';
import { ghlSearchContactsByTag } from './_ghl.js';
import { clickUpConfigured, cuListChannels, cuPostLong } from './_clickup.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ok = (res, data = {}) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

const CHANNEL_LABELS = { announcement: 'Announcement', email_blast: 'Email blast', sms_blast: 'SMS blast', ads: 'Ads', other: 'Other' };
const chLabel = k => CHANNEL_LABELS[k] || String(k || 'other').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function slug(s) {
    return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}
function normEmail(x) {
    const s = String(x == null ? '' : x).trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.slice(0, 200) : '';
}
function normChannel(x) {
    const s = String(x == null ? '' : x).trim().toLowerCase();
    if (!s) return 'other';
    if (/announc|organic/.test(s)) return 'announcement';
    if (/e-?mail/.test(s)) return 'email_blast';
    if (/sms|text/.test(s)) return 'sms_blast';
    if (/\bads?\b|paid|facebook|google|meta/.test(s)) return 'ads';
    return slug(s).replace(/-/g, '_') || 'other';
}

// Per-channel counts for a set of events.
async function channelCounts(eventIds) {
    if (!eventIds.length) return {};
    const { data } = await supabase.from('marketing_event_contacts')
        .select('event_id, channel').in('event_id', eventIds).limit(100000);
    const out = {};
    (data || []).forEach(r => {
        (out[r.event_id] || (out[r.event_id] = { total: 0, by_channel: {} }));
        out[r.event_id].total++;
        out[r.event_id].by_channel[r.channel] = (out[r.event_id].by_channel[r.channel] || 0) + 1;
    });
    return out;
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
    const session = await validateStaff(req);
    if (!session) return sessionErrorResponse(res);
    const { data: caller } = await supabase.from('app_users')
        .select('role, access_marketing, first_name, last_name').eq('userid', session.userid).maybeSingle();
    const canAccess = !!caller && (caller.role === 'super_admin' || caller.role === 'admin' || caller.access_marketing === true);
    if (!canAccess) return bad(res, 'Access denied.', 403);

    const action = req.body?.action;
    try {
        if (action === 'list_events') {
            const { data: events } = await supabase.from('marketing_show_events')
                .select('*').order('created_at', { ascending: false });
            const ids = (events || []).map(e => e.id);
            const counts = await channelCounts(ids);
            return ok(res, { events: (events || []).map(e => ({ ...e, stats: counts[e.id] || { total: 0, by_channel: {} } })) });
        }

        if (action === 'get_event') {
            const { id } = req.body;
            const { data: ev } = await supabase.from('marketing_show_events').select('*').eq('id', id).maybeSingle();
            if (!ev) return bad(res, 'Event not found.');
            const counts = await channelCounts([id]);
            return ok(res, { event: ev, stats: counts[id] || { total: 0, by_channel: {} }, channel_labels: CHANNEL_LABELS });
        }

        if (action === 'create_event') {
            const name = String(req.body.name || '').trim();
            if (!name) return bad(res, 'Event name required.');
            let key = slug(req.body.event_key || name);
            // Ensure unique key.
            const { data: exists } = await supabase.from('marketing_show_events').select('id').eq('event_key', key).maybeSingle();
            if (exists) key = key + '-' + Math.random().toString(36).slice(2, 6);
            const { data, error } = await supabase.from('marketing_show_events').insert({
                name, event_key: key,
                event_date: req.body.event_date || null,
                description: req.body.description || null,
                ghl_location_id: req.body.ghl_location_id || null,
                created_by: `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || String(session.userid)
            }).select('*').single();
            if (error) throw error;
            return ok(res, { event: data });
        }

        if (action === 'update_event') {
            const { id } = req.body;
            if (!id) return bad(res, 'id required');
            const patch = { updated_at: new Date().toISOString() };
            ['name', 'event_date', 'description', 'status', 'ghl_location_id'].forEach(f => {
                if (req.body[f] !== undefined) patch[f] = req.body[f] || null;
            });
            const { error } = await supabase.from('marketing_show_events').update(patch).eq('id', id);
            if (error) throw error;
            return ok(res);
        }

        if (action === 'delete_event') {
            const { id } = req.body;
            if (!id) return bad(res, 'id required');
            const { error } = await supabase.from('marketing_show_events').delete().eq('id', id);
            if (error) throw error;
            return ok(res);
        }

        if (action === 'list_contacts') {
            const { id, channel, q } = req.body;
            if (!id) return bad(res, 'id required');
            let query = supabase.from('marketing_event_contacts').select('*').eq('event_id', id).order('created_at', { ascending: false }).limit(5000);
            if (channel) query = query.eq('channel', channel);
            const { data } = await query;
            let rows = data || [];
            if (q) {
                const s = String(q).toLowerCase();
                rows = rows.filter(r => (r.name || '').toLowerCase().includes(s) || (r.email || '').toLowerCase().includes(s) || (r.phone || '').includes(s));
            }
            return ok(res, { contacts: rows });
        }

        // Import CSV rows: [{name,email,phone,source}], assigned to a channel.
        if (action === 'import_csv') {
            const { id, channel, rows } = req.body;
            if (!id || !Array.isArray(rows)) return bad(res, 'id + rows required');
            const ch = normChannel(channel);
            const seen = new Set();
            const clean = [];
            rows.forEach(r => {
                const email = normEmail(r.email);
                const name = String(r.name || '').slice(0, 200) || null;
                const phone = String(r.phone || '').slice(0, 60) || null;
                if (!email && !phone && !name) return;
                const dedupeKey = email || ('p:' + phone) || ('n:' + name);
                if (email && seen.has(email)) return;
                if (email) seen.add(email);
                clean.push({ event_id: id, channel: ch, name, email: email || null, phone, source: String(r.source || '').slice(0, 120) || 'CSV import', tags: [], origin: 'csv' });
            });
            if (!clean.length) return ok(res, { imported: 0 });
            // Upsert emailed rows (dedupe), insert the rest.
            const withEmail = clean.filter(r => r.email);
            const noEmail = clean.filter(r => !r.email);
            let imported = 0;
            for (let i = 0; i < withEmail.length; i += 500) {
                const chunk = withEmail.slice(i, i + 500);
                const { error } = await supabase.from('marketing_event_contacts').upsert(chunk, { onConflict: 'event_id,email,channel', ignoreDuplicates: true });
                if (!error) imported += chunk.length;
            }
            for (let i = 0; i < noEmail.length; i += 500) {
                const { error } = await supabase.from('marketing_event_contacts').insert(noEmail.slice(i, i + 500));
                if (!error) imported += Math.min(500, noEmail.length - i);
            }
            await supabase.from('marketing_show_events').update({ updated_at: new Date().toISOString() }).eq('id', id);
            return ok(res, { imported });
        }

        // ── Public share link (manual on/off + optional auto-expire date) ──
        if (action === 'get_share' || action === 'set_share' || action === 'regen_share') {
            const { id } = req.body;
            if (!id) return bad(res, 'id required');
            let { data: ev } = await supabase.from('marketing_show_events')
                .select('id, share_token, share_active, share_until, share_show_contacts').eq('id', id).maybeSingle();
            if (!ev) return bad(res, 'Event not found.');
            const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            const mkToken = () => randomBytes(18).toString('base64url');

            if (action === 'regen_share') {
                const token = mkToken();
                await supabase.from('marketing_show_events').update({ share_token: token }).eq('id', id);
                ev.share_token = token;
            }
            if (action === 'set_share') {
                const patch = {};
                if (req.body.active !== undefined) patch.share_active = !!req.body.active;
                if (req.body.until !== undefined) patch.share_until = req.body.until || null;
                if (req.body.show_contacts !== undefined) patch.share_show_contacts = !!req.body.show_contacts;
                // Turning it on for the first time mints a token.
                if (patch.share_active && !ev.share_token) patch.share_token = mkToken();
                patch.updated_at = new Date().toISOString();
                const { error } = await supabase.from('marketing_show_events').update(patch).eq('id', id);
                if (error) throw error;
                ev = { ...ev, ...patch };
            }
            const token = ev.share_token || null;
            const url = token ? `${proto}://${host}/event-view?token=${token}` : null;
            const live = !!(ev.share_active && token && (!ev.share_until || new Date(ev.share_until + 'T23:59:59') >= new Date()));
            return ok(res, { token, url, active: !!ev.share_active, until: ev.share_until || null, show_contacts: ev.share_show_contacts !== false, live });
        }

        // Delete one contact row (fix a single bad entry).
        if (action === 'delete_contact') {
            const { contact_id } = req.body;
            if (!contact_id) return bad(res, 'contact_id required');
            const { error } = await supabase.from('marketing_event_contacts').delete().eq('id', contact_id);
            if (error) throw error;
            return ok(res);
        }

        // Clear all contacts in one channel of an event (undo a bad tab import).
        // Pass channel omitted/'' to clear the WHOLE event's contacts.
        if (action === 'clear_channel') {
            const { id, channel } = req.body;
            if (!id) return bad(res, 'id required');
            let del = supabase.from('marketing_event_contacts').delete().eq('event_id', id);
            if (channel) del = del.eq('channel', normChannel(channel));
            const { error } = await del;
            if (error) throw error;
            await supabase.from('marketing_show_events').update({ updated_at: new Date().toISOString() }).eq('id', id);
            return ok(res);
        }

        // Backfill from GHL by tag → a channel.
        if (action === 'backfill_ghl') {
            const { id, location_id, tag, channel } = req.body;
            if (!id || !location_id || !tag) return bad(res, 'id, location_id and tag are required.');
            const ch = normChannel(channel);
            const r = await ghlSearchContactsByTag(location_id, tag, 500);
            const list = r.contacts || [];
            const rows = list.map(c => ({
                event_id: id, channel: ch, name: c.name || null, email: normEmail(c.email) || null,
                phone: c.phone || null, source: 'GHL: ' + tag, tags: c.tags || [], ghl_contact_id: c.id || null, origin: 'ghl_sync'
            })).filter(x => x.email || x.phone || x.name);
            const withEmail = rows.filter(x => x.email);
            const noEmail = rows.filter(x => !x.email);
            let added = 0;
            if (withEmail.length) { const { error } = await supabase.from('marketing_event_contacts').upsert(withEmail, { onConflict: 'event_id,email,channel', ignoreDuplicates: true }); if (!error) added += withEmail.length; }
            if (noEmail.length) { const { error } = await supabase.from('marketing_event_contacts').insert(noEmail); if (!error) added += noEmail.length; }
            return ok(res, { found: list.length, added, method: r.method, error: r.error || null });
        }

        // Webhook setup info (URL + whether a secret is configured; set a secret).
        if (action === 'get_webhook_info') {
            const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
            const host = req.headers['x-forwarded-host'] || req.headers.host;
            const secret = process.env.EVENTS_WEBHOOK_SECRET || (await getConfigValue('EVENTS_WEBHOOK_SECRET'));
            return ok(res, { url: `${proto}://${host}/api/event-intake`, has_secret: !!secret, secret_in_env: !!process.env.EVENTS_WEBHOOK_SECRET });
        }
        if (action === 'set_webhook_secret') {
            const s = String(req.body.secret || '').trim();
            if (s.length < 8) return bad(res, 'Use a secret of at least 8 characters.');
            await setConfigValue('EVENTS_WEBHOOK_SECRET', s);
            return ok(res);
        }

        // Post an event summary (per-channel + contacts) to ClickUp.
        if (action === 'send_clickup') {
            const { id, channel_id } = req.body;
            const { data: ev } = await supabase.from('marketing_show_events').select('*').eq('id', id).maybeSingle();
            if (!ev) return bad(res, 'Event not found.');
            const { data: settings } = await supabase.from('app_settings').select('key, value').in('key', ['clickup_workspace_id', 'clickup_channel_events']);
            const m = Object.fromEntries((settings || []).map(r => [r.key, r.value]));
            const wid = m.clickup_workspace_id;
            const chId = channel_id || m.clickup_channel_events;
            if (!(await clickUpConfigured()) || !wid) return bad(res, 'ClickUp not connected (set it up in Secret Dungeon → Sending Reports).');
            if (!chId) return bad(res, 'Pick a ClickUp channel.');
            const { data: contacts } = await supabase.from('marketing_event_contacts').select('*').eq('event_id', id).order('channel').limit(100000);
            const byCh = {};
            (contacts || []).forEach(c => { (byCh[c.channel] || (byCh[c.channel] = [])).push(c); });
            let md = `🎬 **${ev.name}**${ev.event_date ? ` — ${ev.event_date}` : ''}\n• Total contacts: **${(contacts || []).length}**\n`;
            md += Object.keys(byCh).sort().map(k => `• ${chLabel(k)}: **${byCh[k].length}**`).join('\n') + '\n';
            Object.keys(byCh).sort().forEach(k => {
                md += `\n**${chLabel(k)} (${byCh[k].length})**\n`;
                md += byCh[k].map((c, i) => `   ${i + 1}. ${c.name || '—'}${c.email ? ` · ${c.email}` : ''}${c.phone ? ` · ${c.phone}` : ''}`).join('\n') + '\n';
            });
            const r = await cuPostLong(wid, chId, md);
            if (!r.ok) return bad(res, r.error || 'ClickUp send failed.');
            if (channel_id) await supabase.from('app_settings').upsert({ key: 'clickup_channel_events', value: String(channel_id), updated_at: new Date().toISOString() }, { onConflict: 'key' });
            return ok(res, { posted: true, parts: r.parts || 1 });
        }
        if (action === 'clickup_channels') {
            const { data: settings } = await supabase.from('app_settings').select('key, value').in('key', ['clickup_workspace_id', 'clickup_workspace_name', 'clickup_channel_events']);
            const m = Object.fromEntries((settings || []).map(r => [r.key, r.value]));
            const configured = await clickUpConfigured();
            let channels = [];
            if (configured && m.clickup_workspace_id) { const r = await cuListChannels(m.clickup_workspace_id); if (r.ok) channels = r.channels; }
            return ok(res, { configured, workspace_id: m.clickup_workspace_id || '', workspace_name: m.clickup_workspace_name || '', channel: m.clickup_channel_events || '', channels });
        }

        return bad(res, 'Unknown action');
    } catch (err) {
        console.error('Events API Error:', err.message);
        return bad(res, err.message, 500);
    }
}
