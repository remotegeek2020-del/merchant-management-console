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
