// PUBLIC booking endpoint (no auth) — powers the white-label booking page.
// get_public_calendar → public-safe calendar design; get_slots → available times
// (computed from availability in the calendar's timezone, minus existing bookings);
// book_slot → creates a contact + appointment and returns add-to-calendar details.
import { createClient } from '@supabase/supabase-js';
import { sendAgencyEmail } from './_agency-mail.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function icsStamp(iso) { const d = new Date(iso), p = n => (n < 10 ? '0' : '') + n; return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z'; }
function addToCalLinks(b) {
    const g = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(b.title) + '&dates=' + icsStamp(b.start) + '/' + icsStamp(b.end) + '&details=' + encodeURIComponent(b.description || '') + '&location=' + encodeURIComponent(b.location || '');
    const o = 'https://outlook.office.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=' + encodeURIComponent(b.title) + '&startdt=' + encodeURIComponent(b.start) + '&enddt=' + encodeURIComponent(b.end) + '&body=' + encodeURIComponent(b.description || '') + '&location=' + encodeURIComponent(b.location || '');
    return { google: g, outlook: o };
}
// Confirmation / update email to the attendee, sent from the agency's white-label sender.
async function sendBookingEmail(cal, appt, origin, kind) {
    const start = new Date(appt.starts_at).getTime(), end = new Date(appt.ends_at).getTime();
    const when = new Date(start).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
    const links = addToCalLinks({ title: cal.name, start: appt.starts_at, end: appt.ends_at, location: appt.location, description: cal.description || '' });
    const manageUrl = (origin && /^https:\/\//.test(origin) ? origin : (process.env.SITE_URL || 'https://portal.mypayprotec.com')) + '/partner/book?manage=' + appt.manage_token;
    const title = kind === 'reschedule' ? `Updated: ${cal.name}` : (kind === 'cancel' ? `Cancelled: ${cal.name}` : `Confirmed: ${cal.name}`);
    const intro = kind === 'reschedule' ? 'Your booking has been rescheduled.' : (kind === 'cancel' ? 'Your booking has been cancelled.' : 'Your booking is confirmed. See you then!');
    let html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;border:1px solid #e2e8f0;border-radius:16px;">
        <h2 style="color:#0a1628;font-size:20px;margin:0 0 6px;">${title}</h2>
        <p style="color:#475569;line-height:1.6;">${intro}</p>
        <div style="background:#f8fafc;border-radius:12px;padding:14px 16px;margin:16px 0;">
          <div style="font-weight:800;font-size:15px;">${cal.name}</div>
          <div style="color:#475569;font-size:14px;margin-top:4px;">🗓️ ${when}</div>
          ${appt.location ? `<div style="color:#475569;font-size:14px;margin-top:2px;">📍 ${appt.location}</div>` : ''}
        </div>`;
    if (kind !== 'cancel') {
        html += `<div style="margin:14px 0;"><a href="${links.google}" style="color:#0d9488;font-weight:700;text-decoration:none;margin-right:14px;">Add to Google</a><a href="${links.outlook}" style="color:#0d9488;font-weight:700;text-decoration:none;">Add to Outlook</a></div>
          <p style="font-size:13px;color:#64748b;">Need to change it? <a href="${manageUrl}" style="color:#0d9488;font-weight:700;">Reschedule or cancel</a>.</p>`;
    }
    html += `</div>`;
    const text = `${title}\n${intro}\n\n${cal.name}\n${when}${appt.location ? '\n' + appt.location : ''}\n\nManage: ${manageUrl}`;
    try { await sendAgencyEmail(cal.portal_id, { to: appt.attendee_email, subject: title, html, text }); } catch (e) { /* best-effort */ }
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_AVAIL = { mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }], wed: [{ start: '09:00', end: '17:00' }], thu: [{ start: '09:00', end: '17:00' }], fri: [{ start: '09:00', end: '17:00' }] };

// Offset (minutes) of `tz` at the instant `date` (UTC Date).
function tzOffsetMinutes(date, tz) {
    try {
        const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
        const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
        return (asUTC - date.getTime()) / 60000;
    } catch (e) { return 0; }
}
// Wall-clock (y,m,d,hh,mm) in tz → UTC Date.
function wallToUtc(y, m, d, hh, mm, tz) {
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const off = tzOffsetMinutes(new Date(guess), tz);
    return new Date(guess - off * 60000);
}
// The weekday index (0=Sun) for a Y-M-D as seen in tz (noon avoids DST edges).
function weekdayInTz(y, m, d, tz) {
    const noon = wallToUtc(y, m, d, 12, 0, tz);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(noon);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}
function pubCal(cal, hostNames) {
    return {
        id: cal.id, name: cal.name, description: cal.description, type: cal.type,
        duration_min: cal.duration_min, timezone: cal.timezone,
        location_type: cal.location_type, location_value: cal.location_value,
        template: cal.template, color_primary: cal.color_primary, color_accent: cal.color_accent,
        confirmation_message: cal.confirmation_message, hosts: hostNames, active: cal.active
    };
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const body = req.body || {};
    const action = body.action || (req.method === 'GET' ? 'get_public_calendar' : null);
    const calId = body.calendar_id || (req.query && (req.query.c || req.query.cal));
    try {
        if (!calId) return res.status(400).json({ success: false, message: 'Missing calendar.' });
        const { data: cal } = await supabase.from('crm_calendars').select('*').eq('id', calId).maybeSingle();
        if (!cal) return res.status(404).json({ success: false, message: 'Calendar not found.' });
        if (!cal.active && action !== 'get_public_calendar') return res.status(403).json({ success: false, message: 'This calendar is not accepting bookings.' });

        const hostIds = Array.isArray(cal.host_person_ids) ? cal.host_person_ids : [];
        const avail = (cal.availability && Object.keys(cal.availability).length) ? cal.availability : DEFAULT_AVAIL;

        if (action === 'get_public_calendar') {
            let hostNames = [];
            if (hostIds.length) { const { data: ppl } = await supabase.from('persons').select('id, full_name').in('id', hostIds); hostNames = (ppl || []).map(p => p.full_name).filter(Boolean); }
            return res.status(200).json({ success: true, calendar: pubCal(cal, hostNames), active: cal.active });
        }

        // Busy intervals for the calendar's hosts (blocks double-booking across calendars).
        async function busyByHost(rangeStartISO, rangeEndISO) {
            const map = {}; hostIds.forEach(h => map[h] = []);
            if (!hostIds.length) return map;
            const { data: appts } = await supabase.from('crm_appointments')
                .select('starts_at, ends_at, host_person_id, status')
                .in('host_person_id', hostIds)
                .neq('status', 'cancelled')
                .gte('starts_at', rangeStartISO).lte('starts_at', rangeEndISO);
            (appts || []).forEach(a => {
                if (!a.host_person_id || !a.starts_at) return;
                const s = new Date(a.starts_at).getTime();
                const e = a.ends_at ? new Date(a.ends_at).getTime() : s + cal.duration_min * 60000;
                (map[a.host_person_id] = map[a.host_person_id] || []).push([s, e]);
            });
            return map;
        }
        function freeHostsAt(busy, s, e) {
            return hostIds.filter(h => !(busy[h] || []).some(([bs, be]) => s < be && e > bs));
        }

        if (action === 'get_slots') {
            const tz = cal.timezone || 'America/New_York';
            const now = Date.now();
            const minStart = now + (cal.min_notice_min || 0) * 60000;
            const rangeEnd = now + (cal.date_range_days || 30) * 86400000;
            const busy = await busyByHost(new Date(now - 86400000).toISOString(), new Date(rangeEnd + 86400000).toISOString());
            const dur = cal.duration_min || 30;
            const slots = [];
            // Walk each calendar day in the window.
            for (let t = now; t <= rangeEnd; t += 86400000) {
                const dt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
                const y = +dt.year, mo = +dt.month, d = +dt.day;
                const wd = weekdayInTz(y, mo, d, tz);
                const windows = avail[DAYS[wd]] || [];
                windows.forEach(w => {
                    const [sh, sm] = String(w.start || '09:00').split(':').map(Number);
                    const [eh, em] = String(w.end || '17:00').split(':').map(Number);
                    const winStart = wallToUtc(y, mo, d, sh, sm, tz).getTime();
                    const winEnd = wallToUtc(y, mo, d, eh, em, tz).getTime();
                    for (let s = winStart; s + dur * 60000 <= winEnd; s += dur * 60000) {
                        const e = s + dur * 60000;
                        if (s < minStart || s > rangeEnd) continue;
                        const free = hostIds.length ? freeHostsAt(busy, s, e) : [null];
                        const ok = cal.type === 'round_robin' ? free.length > 0 : (free.length === hostIds.length || !hostIds.length);
                        if (ok) slots.push(new Date(s).toISOString());
                    }
                });
            }
            slots.sort();
            return res.status(200).json({ success: true, slots, timezone: tz, duration_min: dur });
        }

        if (action === 'book_slot') {
            const startISO = body.start;
            if (!startISO) return res.status(400).json({ success: false, message: 'Pick a time.' });
            const name = String(body.name || '').trim();
            const email = String(body.email || '').trim();
            const phone = String(body.phone || '').trim();
            if (!name || !email) return res.status(400).json({ success: false, message: 'Name and email are required.' });
            const start = new Date(startISO).getTime();
            if (isNaN(start)) return res.status(400).json({ success: false, message: 'Invalid time.' });
            const dur = cal.duration_min || 30;
            const end = start + dur * 60000;
            if (start < Date.now() + (cal.min_notice_min || 0) * 60000) return res.status(400).json({ success: false, message: 'That time is no longer available.' });
            // Re-check availability server-side.
            const busy = await busyByHost(new Date(start - 86400000).toISOString(), new Date(end + 86400000).toISOString());
            const free = hostIds.length ? freeHostsAt(busy, start, end) : [null];
            const ok = cal.type === 'round_robin' ? free.length > 0 : (free.length === hostIds.length || !hostIds.length);
            if (!ok) return res.status(409).json({ success: false, message: 'Sorry, that time was just taken. Please pick another.' });
            const hostId = hostIds.length ? (cal.type === 'round_robin' ? free[0] : hostIds[0]) : null;

            // Find or create the contact in this CRM (match by email).
            const first = name.split(/\s+/)[0] || name;
            const last = name.split(/\s+/).slice(1).join(' ') || null;
            let contactId = null;
            const { data: existing } = await supabase.from('crm_contacts').select('id').eq('sub_account_id', cal.sub_account_id).ilike('email', email).limit(1);
            if (existing && existing.length) contactId = existing[0].id;
            else {
                const { data: nc } = await supabase.from('crm_contacts').insert({ sub_account_id: cal.sub_account_id, portal_id: cal.portal_id, first_name: first, last_name: last, email, phone: phone || null, source: 'Booking: ' + cal.name, status: 'active', owner_person_id: hostId || null }).select('id').single();
                contactId = nc ? nc.id : null;
            }
            const locMap = { in_person: cal.location_value || 'In person', phone: 'Phone call', video: cal.location_value || 'Video call', custom: cal.location_value || '' };
            const location = locMap[cal.location_type] || cal.location_value || '';
            const icsUid = 'bk-' + Math.abs(start).toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '@mypayprotec';
            const manageToken = 'm' + Math.abs(start).toString(36) + Math.random().toString(36).slice(2, 12);
            const { data: appt, error } = await supabase.from('crm_appointments').insert({
                sub_account_id: cal.sub_account_id, portal_id: cal.portal_id, calendar_id: cal.id,
                contact_id: contactId, host_person_id: hostId,
                title: cal.name + ' with ' + name, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(),
                location, notes: body.notes || null, status: 'scheduled',
                attendee_name: name, attendee_email: email, attendee_phone: phone || null,
                ics_uid: icsUid, source: 'booking', manage_token: manageToken
            }).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not book. Please try again.' });
            // Log to the contact conversation (best-effort).
            try { await supabase.from('crm_messages').insert({ sub_account_id: cal.sub_account_id, portal_id: cal.portal_id, contact_id: contactId, direction: 'inbound', channel: 'note', body: 'Booked "' + cal.name + '" for ' + new Date(start).toISOString() }); } catch (e) {}
            // White-label confirmation email (best-effort — booking still succeeds if email unset).
            sendBookingEmail(cal, appt, body.origin, 'confirm');
            return res.status(200).json({
                success: true,
                booking: {
                    title: cal.name, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
                    location, description: (cal.description || '') + (body.notes ? ('\n\nNotes: ' + body.notes) : ''),
                    ics_uid: icsUid, duration_min: dur, manage_token: manageToken
                },
                message: cal.confirmation_message || 'Your booking is confirmed. See you then!'
            });
        }

        // ── Manage an existing booking (public, by token) ──
        if (action === 'get_booking' || action === 'cancel_booking' || action === 'reschedule_booking') {
            const mt = body.manage_token;
            if (!mt) return res.status(400).json({ success: false, message: 'Missing booking reference.' });
            const { data: appt } = await supabase.from('crm_appointments').select('*').eq('manage_token', mt).maybeSingle();
            if (!appt) return res.status(404).json({ success: false, message: 'Booking not found.' });
            const { data: bcal } = await supabase.from('crm_calendars').select('*').eq('id', appt.calendar_id).maybeSingle();

            if (action === 'get_booking') {
                return res.status(200).json({ success: true, booking: { title: appt.title, start: appt.starts_at, end: appt.ends_at, location: appt.location, status: appt.status, attendee_name: appt.attendee_name, calendar_name: bcal ? bcal.name : null, calendar_id: appt.calendar_id } });
            }
            if (action === 'cancel_booking') {
                if (appt.status === 'cancelled') return res.status(200).json({ success: true, already: true });
                await supabase.from('crm_appointments').update({ status: 'cancelled' }).eq('id', appt.id);
                try { await supabase.from('crm_messages').insert({ sub_account_id: appt.sub_account_id, portal_id: appt.portal_id, contact_id: appt.contact_id, direction: 'inbound', channel: 'note', body: 'Cancelled booking "' + (bcal ? bcal.name : '') + '"' }); } catch (e) {}
                if (bcal) sendBookingEmail(bcal, appt, body.origin, 'cancel');
                return res.status(200).json({ success: true });
            }
            if (action === 'reschedule_booking') {
                if (!bcal) return res.status(404).json({ success: false, message: 'Calendar not found.' });
                const nStart = new Date(body.start).getTime();
                if (isNaN(nStart)) return res.status(400).json({ success: false, message: 'Pick a time.' });
                const nDur = bcal.duration_min || 30, nEnd = nStart + nDur * 60000;
                if (nStart < Date.now() + (bcal.min_notice_min || 0) * 60000) return res.status(400).json({ success: false, message: 'That time is no longer available.' });
                const bHostIds = Array.isArray(bcal.host_person_ids) ? bcal.host_person_ids : [];
                // conflict check excluding THIS appointment
                let conflict = false;
                if (appt.host_person_id) {
                    const { data: other } = await supabase.from('crm_appointments').select('starts_at,ends_at').eq('host_person_id', appt.host_person_id).neq('status', 'cancelled').neq('id', appt.id).gte('starts_at', new Date(nStart - 86400000).toISOString()).lte('starts_at', new Date(nEnd + 86400000).toISOString());
                    conflict = (other || []).some(a => { const s = new Date(a.starts_at).getTime(), e = a.ends_at ? new Date(a.ends_at).getTime() : s + nDur * 60000; return nStart < e && nEnd > s; });
                }
                if (conflict) return res.status(409).json({ success: false, message: 'That time was just taken. Please pick another.' });
                await supabase.from('crm_appointments').update({ starts_at: new Date(nStart).toISOString(), ends_at: new Date(nEnd).toISOString(), status: 'scheduled' }).eq('id', appt.id);
                const updated = { ...appt, starts_at: new Date(nStart).toISOString(), ends_at: new Date(nEnd).toISOString() };
                sendBookingEmail(bcal, updated, body.origin, 'reschedule');
                return res.status(200).json({ success: true, booking: { start: updated.starts_at, end: updated.ends_at } });
            }
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
}
