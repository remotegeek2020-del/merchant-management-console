// ── PUBLIC EVENT VIEW (read-only, token-gated share link) ────────────────────
// Serves one event's stats/contacts to anyone holding the share token, but only
// while the link is "live": share_active = true AND (no share_until OR not past
// end of that date). No staff auth — the token IS the access. Read-only.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ok = (res, data = {}) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 200) => res.status(status).json({ success: false, message });

const CHANNEL_LABELS = { announcement: 'Announcement', email_blast: 'Email blast', sms_blast: 'SMS blast', ads: 'Ads', other: 'Other' };
const chLabel = k => CHANNEL_LABELS[k] || String(k || 'other').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const token = String(body?.token || '').trim();
    if (!token) return bad(res, 'Missing token.');

    const { data: ev } = await supabase.from('marketing_show_events')
        .select('id, name, event_date, description, share_active, share_until, share_show_contacts')
        .eq('share_token', token).maybeSingle();
    if (!ev) return bad(res, 'This link is not valid.');

    // Live check: manual toggle on AND within the (optional) date.
    const live = !!(ev.share_active && (!ev.share_until || new Date(ev.share_until + 'T23:59:59') >= new Date()));
    if (!live) {
        const reason = !ev.share_active ? 'This share link is turned off.' : 'This share link has expired.';
        return res.status(200).json({ success: false, inactive: true, message: reason });
    }

    // Accurate per-channel counts via SQL aggregate (not the 1000-row cap).
    const { data: counts } = await supabase.rpc('event_channel_counts', { p_event: ev.id });
    const byChannel = {};
    let total = 0;
    (counts || []).forEach(r => { byChannel[r.channel] = Number(r.cnt) || 0; total += Number(r.cnt) || 0; });

    const showContacts = ev.share_show_contacts !== false;
    // Fetch ALL contacts (paginated past the 1000-row cap) when the list is shown.
    let contacts = [];
    if (showContacts) {
        const size = 1000;
        for (let page = 0; page < 60; page++) {
            const { data } = await supabase.from('marketing_event_contacts')
                .select('name, email, phone, channel, source, created_at').eq('event_id', ev.id)
                .order('created_at', { ascending: false }).range(page * size, page * size + size - 1);
            if (!data || !data.length) break;
            contacts.push(...data);
            if (data.length < size) break;
        }
    }

    return ok(res, {
        event: { name: ev.name, event_date: ev.event_date, description: ev.description },
        total,
        by_channel: byChannel,
        channel_labels: CHANNEL_LABELS,
        show_contacts: showContacts,
        contacts
    });
}
