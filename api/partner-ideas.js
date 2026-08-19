// Partner/CRM-facing Ideas & Suggestions. Partner-token authed. Submissions land
// in the SAME staff board (feature_ideas) with source attribution, and notify the
// web developer + super admins. Whitelabel-safe: no PayProTec branding is returned
// to the client (the CRM/portal renders its own agency branding).
import { createClient } from '@supabase/supabase-js';
import { sendAgencyEmail } from './_agency-mail.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const ALLOWED_CATS = ['communications', 'general', 'ui_ux', 'reporting', 'calendars', 'automation', 'billing', 'other'];

async function validatePartner(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function notifyDevAndAdmins(idea, submitter, context, host) {
    const subject = `💡 Suggestion (${idea.category}): "${idea.title}"`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:540px;margin:auto;padding:28px;border:1px solid #e2e8f0;border-radius:14px;color:#1e293b;">
        <h3 style="margin:0 0 8px;color:#004990;">New suggestion from a ${idea.source === 'crm' ? 'CRM user' : 'partner'}</h3>
        <p style="margin:0 0 14px;line-height:1.6;">From <strong>${esc(submitter)}</strong>${context ? ' · <strong>' + esc(context) + '</strong>' : ''} · Category: <strong>${esc(idea.category)}</strong></p>
        <div style="background:#f8fafc;border-radius:10px;padding:16px;margin-bottom:16px;">
            <p style="font-weight:700;margin:0 0 6px;">${esc(idea.title)}</p>
            <p style="color:#475569;margin:0;font-size:13px;line-height:1.6;">${esc(String(idea.body).slice(0, 500))}</p>
        </div>
        <div style="text-align:center;"><a href="https://${host || 'portal.mypayprotec.com'}/ideas-dashboard.html" style="background:#004990;color:#fff;padding:11px 22px;text-decoration:none;border-radius:8px;font-weight:700;">Review on the Ideas board</a></div>
    </div>`;
    const text = `New ${idea.source} suggestion from ${submitter}${context ? ' (' + context + ')' : ''} — [${idea.category}] ${idea.title}\n\n${idea.body}`;
    // Recipients: web developer(s) from site_settings + active super admins.
    const recipients = new Set();
    try { const { data: s } = await supabase.from('site_settings').select('value').eq('key', 'web_developer_email').maybeSingle(); (s && s.value ? String(s.value).split(',') : []).forEach(e => { const t = e.trim(); if (t) recipients.add(t); }); } catch (e) {}
    try { const { data: admins } = await supabase.from('app_users').select('email').eq('role', 'super_admin').eq('is_active', true); (admins || []).forEach(a => { if (a.email) recipients.add(a.email.trim()); }); } catch (e) {}
    if (!recipients.size || !process.env.POSTMARK_SERVER_TOKEN) return;
    try {
        const { ServerClient } = await import('postmark');
        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
        for (const to of recipients) { try { await client.sendEmail({ From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com', To: to, Subject: subject, HtmlBody: html, TextBody: text, MessageStream: 'outbound' }); } catch (e) {} }
    } catch (e) {}
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const body = req.body || {};
    const action = body.action;
    try {
        const personId = await validatePartner(body.token);
        if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });
        const { data: person } = await supabase.from('persons').select('id, full_name, email').eq('id', personId).maybeSingle();
        const who = (person && person.full_name) || 'Partner';

        if (action === 'submit') {
            const title = String(body.title || '').trim();
            const desc = String(body.body || '').trim();
            if (!title) return res.status(400).json({ success: false, message: 'A short title is required.' });
            if (!desc) return res.status(400).json({ success: false, message: 'Please describe your idea.' });
            const category = ALLOWED_CATS.includes(body.category) ? body.category : 'general';
            const source = body.source === 'crm' ? 'crm' : 'partner';
            const context = String(body.context || '').slice(0, 120) || null;
            const row = {
                title: title.slice(0, 160), body: desc.slice(0, 4000), category, status: 'open',
                requested_by_userid: personId, requested_by_name: who + (source === 'crm' ? ' (CRM)' : ' (Partner)'),
                source, source_context: context, sub_account_id: body.sub_account_id || null,
                submitter_email: (person && person.email) || null
            };
            const { data, error } = await supabase.from('feature_ideas').insert(row).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not submit. Please try again.' });
            notifyDevAndAdmins(data, who, context, req.headers.host);
            return res.status(200).json({ success: true, idea: publicIdea(data, personId) });
        }

        if (action === 'my_list') {
            // The submitter's own suggestions; if a CRM sub_account is given, that CRM's too.
            let q = supabase.from('feature_ideas').select('*').order('created_at', { ascending: false }).limit(200);
            if (body.sub_account_id) q = q.eq('sub_account_id', body.sub_account_id);
            else q = q.eq('requested_by_userid', personId);
            const { data } = await q;
            return res.status(200).json({ success: true, ideas: (data || []).map(i => publicIdea(i, personId)), categories: ALLOWED_CATS });
        }

        // Can this person see this idea? (their own, or a CRM they're a member of)
        async function canSee(idea) {
            if (!idea) return false;
            if (idea.requested_by_userid === personId) return true;
            if (idea.sub_account_id) {
                const { data: sub } = await supabase.from('agency_sub_accounts').select('portal_id').eq('id', idea.sub_account_id).maybeSingle();
                if (sub) {
                    const { data: mem } = await supabase.from('partner_portal_members').select('person_id').eq('portal_id', sub.portal_id).eq('person_id', personId).maybeSingle();
                    if (mem) return true;
                    const { data: p } = await supabase.from('persons').select('is_portal_god').eq('id', personId).maybeSingle();
                    if (p && p.is_portal_god) return true;
                }
            }
            return false;
        }

        // Idea detail + its comment thread (team ↔ partner conversation).
        if (action === 'get_idea') {
            const { data: idea } = await supabase.from('feature_ideas').select('*').eq('id', body.id).maybeSingle();
            if (!idea || !(await canSee(idea))) return res.status(403).json({ success: false, message: 'Not found.' });
            const { data: comments } = await supabase.from('idea_comments').select('id, body, posted_by_name, author_type, created_at').eq('idea_id', idea.id).order('created_at', { ascending: true });
            return res.status(200).json({ success: true, idea: publicIdea(idea, personId), comments: comments || [] });
        }

        if (action === 'add_comment') {
            const { data: idea } = await supabase.from('feature_ideas').select('*').eq('id', body.id).maybeSingle();
            if (!idea || !(await canSee(idea))) return res.status(403).json({ success: false, message: 'Not found.' });
            const text = String(body.body || '').trim();
            if (!text) return res.status(400).json({ success: false, message: 'Write a message first.' });
            const { data: c, error } = await supabase.from('idea_comments')
                .insert({ idea_id: idea.id, body: text.slice(0, 2000), posted_by_userid: personId, posted_by_name: who, author_type: 'partner' })
                .select('id, body, posted_by_name, author_type, created_at').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not post.' });
            // Notify the team (web dev + super admins) of the partner reply.
            try {
                const recipients = new Set();
                const { data: s } = await supabase.from('site_settings').select('value').eq('key', 'web_developer_email').maybeSingle();
                (s && s.value ? String(s.value).split(',') : []).forEach(e => { const t = e.trim(); if (t) recipients.add(t); });
                const { data: admins } = await supabase.from('app_users').select('email').eq('role', 'super_admin').eq('is_active', true);
                (admins || []).forEach(a => { if (a.email) recipients.add(a.email.trim()); });
                if (recipients.size && process.env.POSTMARK_SERVER_TOKEN) {
                    const { ServerClient } = await import('postmark');
                    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;"><p><strong>${esc(who)}</strong> replied on suggestion:</p><p style="font-weight:700;">${esc(idea.title)}</p><div style="background:#f8fafc;border-radius:8px;padding:12px;color:#475569;">${esc(text.slice(0, 500))}</div><p style="margin-top:14px;"><a href="https://${req.headers.host || 'portal.mypayprotec.com'}/ideas-dashboard.html">Open the Ideas board</a></p></div>`;
                    for (const to of recipients) { try { await client.sendEmail({ From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com', To: to, Subject: `💬 Reply on "${idea.title}"`, HtmlBody: html, TextBody: `${who} replied on "${idea.title}": ${text}`, MessageStream: 'outbound' }); } catch (e) {} }
                }
            } catch (e) {}
            return res.status(200).json({ success: true, comment: c });
        }

        if (action === 'categories') return res.status(200).json({ success: true, categories: ALLOWED_CATS });

        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
}
// Public-safe shape (no internal staff notes).
function publicIdea(i, personId) {
    return { id: i.id, title: i.title, body: i.body, category: i.category, status: i.status, created_at: i.created_at, mine: i.requested_by_userid === personId, by: i.requested_by_name };
}
