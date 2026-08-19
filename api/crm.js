// CRM data API — per-CRM (sub-account) isolated, HighLevel-style.
// Every read/write is scoped to a sub_account_id the caller can access:
//   • must be a member of the owning agency (partner_portals via partner_portal_members)
//   • sub-partners must have that CRM in their granted scope
//   • portal gods pass
// This mirrors get_sub_account in whitelabel.js so access stays consistent.
import { createClient } from '@supabase/supabase-js';
import { getValidAccessToken, getValidSharedMailboxToken } from './partner-oauth.js';
import { runWorkflows, WORKFLOW_TRIGGERS, WORKFLOW_ACTIONS } from './_automation.js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// The acting user's connected mailbox (provider + address), or null.
async function emailConn(personId) {
    const { data } = await supabase.from('partner_email_connections').select('provider, email').eq('person_id', personId).limit(1);
    return (data && data[0]) || null;
}
// Split "Name <email>" into { email, name }.
function parseAddr(s) {
    const m = String(s || '').match(/<([^>]+)>/);
    const email = (m ? m[1] : (s || '')).trim();
    const name = m ? String(s).replace(/<[^>]+>/, '').replace(/"/g, '').trim() : '';
    return { email, name };
}
// Every mailbox the acting person can use in this CRM (hybrid: shared inbox(es) +
// their own personal mailbox). Shared tokens live in crm_mailboxes; personal in
// partner_email_connections.
async function accessibleMailboxes(personId, subId) {
    // Per-CRM email mode governs which mailboxes are in play.
    const { data: sub } = await supabase.from('agency_sub_accounts').select('email_mode').eq('id', subId).maybeSingle();
    const mode = (sub && sub.email_mode) || 'both';
    const out = [];
    if (mode !== 'individual') {
        const { data: shared } = await supabase.from('crm_mailboxes').select('id, provider, email').eq('sub_account_id', subId).eq('status', 'active');
        (shared || []).forEach(m => out.push({ kind: 'shared', shared_mailbox_id: m.id, person_id: null, provider: m.provider, email: m.email }));
    }
    if (mode !== 'shared') {
        const conn = await emailConn(personId);
        if (conn) out.push({ kind: 'personal', shared_mailbox_id: null, person_id: personId, provider: conn.provider, email: conn.email });
    }
    return out;
}
async function mailboxToken(mb) {
    return mb.kind === 'shared' ? await getValidSharedMailboxToken(mb.shared_mailbox_id) : await getValidAccessToken(mb.person_id, mb.provider);
}
// Pull messages involving `addr` from one mailbox and upsert into crm_emails with
// full attribution (which mailbox, direction). Returns { reauth } on token failure.
async function syncMailboxForContact(mb, addr, subId, portalId, contactId) {
    const at = await mailboxToken(mb);
    if (!at) return { reauth: true };
    const needle = String(addr).toLowerCase().trim();
    let rows = [];
    try {
        if (mb.provider === 'google') {
            const q = encodeURIComponent(`{from:"${addr}" to:"${addr}" cc:"${addr}" bcc:"${addr}"}`);
            const lr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=${q}`, { headers: { Authorization: 'Bearer ' + at } });
            if (lr.status === 403) return { reauth: true };
            const list = await lr.json();
            const ids = (list.messages || []).map(m => m.id);
            const metas = await Promise.all(ids.map(async id => {
                const mr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Bcc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID`, { headers: { Authorization: 'Bearer ' + at } });
                const m = await mr.json();
                const h = {}; ((m.payload && m.payload.headers) || []).forEach(x => h[x.name.toLowerCase()] = x.value);
                return { pid: m.id, thread: m.threadId, rfc: h['message-id'] || '', from: h.from || '', to: h.to || '', cc: h.cc || '', bcc: h.bcc || '', subject: h.subject || '(no subject)', date: m.internalDate ? new Date(Number(m.internalDate)) : null, snippet: m.snippet || '', unread: (m.labelIds || []).includes('UNREAD') };
            }));
            rows = metas.filter(e => [e.from, e.to, e.cc, e.bcc].join(' ').toLowerCase().includes(needle));
        } else {
            const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(addr)}"&$top=25&$select=id,conversationId,internetMessageId,from,toRecipients,ccRecipients,bccRecipients,subject,receivedDateTime,bodyPreview,isRead`, { headers: { Authorization: 'Bearer ' + at, ConsistencyLevel: 'eventual' } });
            if (r.status === 403) return { reauth: true };
            const d = await r.json();
            rows = (d.value || []).map(m => ({ pid: m.id, thread: m.conversationId, rfc: m.internetMessageId || '', from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || '', to: (m.toRecipients || []).map(x => x.emailAddress.address).join(', '), cc: (m.ccRecipients || []).map(x => x.emailAddress.address).join(', '), bcc: (m.bccRecipients || []).map(x => x.emailAddress.address).join(', '), subject: m.subject || '(no subject)', date: m.receivedDateTime ? new Date(m.receivedDateTime) : null, snippet: m.bodyPreview || '', unread: m.isRead === false }))
                .filter(e => [e.from, e.to, e.cc, e.bcc].join(' ').toLowerCase().includes(needle));
        }
    } catch (e) { return { reauth: false }; }

    if (rows.length) {
        const mbEmail = String(mb.email || '').toLowerCase();
        const records = rows.map(e => {
            const fromP = parseAddr(e.from);
            const outbound = !!(mbEmail && fromP.email && fromP.email.toLowerCase() === mbEmail);
            return {
                sub_account_id: subId, portal_id: portalId, contact_id: contactId,
                mailbox_kind: mb.kind, mailbox_email: mb.email, mailbox_person_id: mb.person_id, shared_mailbox_id: mb.shared_mailbox_id,
                provider: mb.provider, provider_message_id: e.pid, provider_thread_id: e.thread, rfc_message_id: e.rfc,
                direction: outbound ? 'outbound' : 'inbound',
                from_address: fromP.email, from_name: fromP.name,
                to_addresses: e.to, cc_addresses: e.cc, bcc_addresses: e.bcc,
                subject: e.subject, snippet: e.snippet,
                sent_at: e.date ? e.date.toISOString() : null, unread: !!e.unread
            };
        });
        await supabase.from('crm_emails').upsert(records, { onConflict: 'sub_account_id,mailbox_email,provider_message_id' });
    }
    return { reauth: false };
}
function b64urlDecode(s) { try { return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (e) { return ''; } }
function b64urlEncode(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
// Walk a Gmail payload tree for the best text/html (fallback text/plain) body.
function extractGmailBody(payload) {
    var html = '', text = '';
    (function walk(p) {
        if (!p) return;
        var mt = p.mimeType || '';
        if (mt === 'text/html' && p.body && p.body.data) html = html || b64urlDecode(p.body.data);
        else if (mt === 'text/plain' && p.body && p.body.data) text = text || b64urlDecode(p.body.data);
        (p.parts || []).forEach(walk);
    })(payload);
    return { html: html, text: text };
}

async function validatePartner(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}
async function isGod(personId) {
    if (!personId) return false;
    const { data } = await supabase.from('persons').select('is_portal_god').eq('id', personId).maybeSingle();
    return !!(data && data.is_portal_god);
}
// Returns { sub, portal_id, role, permissions } if the person may use this CRM
// (optionally restricted to a permission `area`), else null.
//   • owner / god → full
//   • agency_admin → every CRM in the agency (subject to explicit per-area deny)
//   • crm_admin → only CRMs in scope.sub_account_ids (subject to per-area deny)
async function subAccess(personId, subId, area) {
    if (!subId) return null;
    const { data: sub } = await supabase.from('agency_sub_accounts').select('*').eq('id', subId).maybeSingle();
    if (!sub) return null;
    if (await isGod(personId)) return { sub, portal_id: sub.portal_id, role: 'god', permissions: {} };
    const { data: mem } = await supabase.from('partner_portal_members').select('*').eq('portal_id', sub.portal_id).eq('person_id', personId).maybeSingle();
    if (!mem) return null;
    if (mem.role === 'crm_admin' || mem.role === 'sub_partner') {
        const granted = (mem.scope && Array.isArray(mem.scope.sub_account_ids)) ? mem.scope.sub_account_ids : [];
        if (!granted.includes(sub.id)) return null;
    }
    const perms = mem.permissions || {};
    // Owners see all; everyone else is denied an area only if it's explicitly false.
    if (area && mem.role !== 'owner' && perms[area] === false) return null;
    return { sub, portal_id: sub.portal_id, role: mem.role, permissions: perms };
}

const CONTACT_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company', 'title', 'source', 'status', 'notes'];
const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'dropdown', 'checkbox'];
function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || ('f_' + Math.random().toString(36).slice(2, 8));
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const body = req.body || {};
    const action = body.action;
    try {
        const personId = await validatePartner(body.token);
        if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

        // Authorize by a contact row's own sub_account_id (for id-based mutations).
        async function contactAccess(contactId, area) {
            const { data: c } = await supabase.from('crm_contacts').select('*').eq('id', contactId).maybeSingle();
            if (!c) return null;
            const acc = await subAccess(personId, c.sub_account_id, area);
            if (!acc) return null;
            return { contact: c, portal_id: acc.portal_id };
        }

        // ── CONTACTS ─────────────────────────────────────────────────────────
        // Owner-scope filter: null (see all) unless this CRM restricts non-admins to their own.
        function assignedFilter(acc) {
            return (acc.sub && acc.sub.restrict_to_assigned && !['owner', 'agency_admin', 'god'].includes(acc.role)) ? personId : null;
        }

        if (action === 'list_contacts') {
            const acc = await subAccess(personId, body.sub_account_id, 'contacts');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            let cq = supabase.from('crm_contacts').select('*').eq('sub_account_id', body.sub_account_id);
            const own = assignedFilter(acc); if (own) cq = cq.eq('owner_person_id', own);
            if (body.status) cq = cq.eq('status', body.status);
            if (body.owner_person_id) cq = cq.eq('owner_person_id', body.owner_person_id);
            const sortCol = ['created_at', 'first_name', 'last_name', 'company'].includes(body.sort) ? body.sort : 'created_at';
            const { data: contacts } = await cq.order(sortCol, { ascending: body.sort_dir === 'asc' }).limit(5000);
            let list = contacts || [];
            if (body.q) {
                const q = String(body.q).toLowerCase();
                list = list.filter(c => [c.first_name, c.last_name, c.email, c.phone, c.company].some(v => String(v || '').toLowerCase().includes(q)));
            }
            // Tag filter (contact must carry the given tag id).
            const ids0 = list.map(c => c.id);
            const tagMap = {};
            if (ids0.length) {
                const { data: links } = await supabase.from('crm_contact_tags').select('contact_id, crm_tags(id,name,color)').in('contact_id', ids0);
                (links || []).forEach(l => { if (l.crm_tags) (tagMap[l.contact_id] = tagMap[l.contact_id] || []).push(l.crm_tags); });
            }
            if (body.tag_id) list = list.filter(c => (tagMap[c.id] || []).some(t => t.id === body.tag_id));
            const total = list.length;
            const limit = Math.min(parseInt(body.limit, 10) || 100, 500);
            const offset = Math.max(parseInt(body.offset, 10) || 0, 0);
            const paged = (body.all ? list : list.slice(offset, offset + limit)).map(c => ({ ...c, tags: tagMap[c.id] || [] }));
            return res.status(200).json({ success: true, contacts: paged, total, offset, limit });
        }

        // Bulk operations on selected contacts (or all matching, when ids omitted + all:true handled client-side).
        if (action === 'bulk_contacts') {
            const acc = await subAccess(personId, body.sub_account_id, 'contacts');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const ids = Array.isArray(body.ids) ? body.ids : [];
            if (!ids.length) return res.status(400).json({ success: false, message: 'No contacts selected.' });
            // Guard: only contacts in THIS CRM.
            const { data: own } = await supabase.from('crm_contacts').select('id').eq('sub_account_id', body.sub_account_id).in('id', ids);
            const okIds = (own || []).map(c => c.id);
            if (!okIds.length) return res.status(400).json({ success: false, message: 'Nothing to update.' });
            const op = body.op;
            if (op === 'delete') { await supabase.from('crm_contacts').delete().in('id', okIds); return res.status(200).json({ success: true, affected: okIds.length }); }
            if (op === 'status') { await supabase.from('crm_contacts').update({ status: body.value || 'active' }).in('id', okIds); return res.status(200).json({ success: true, affected: okIds.length }); }
            if (op === 'assign') { await supabase.from('crm_contacts').update({ owner_person_id: body.value || null }).in('id', okIds); return res.status(200).json({ success: true, affected: okIds.length }); }
            if (op === 'add_tag' && body.tag_id) {
                const { data: t } = await supabase.from('crm_tags').select('id').eq('sub_account_id', body.sub_account_id).eq('id', body.tag_id).maybeSingle();
                if (t) { const rows = okIds.map(cid => ({ contact_id: cid, tag_id: body.tag_id })); await supabase.from('crm_contact_tags').upsert(rows, { onConflict: 'contact_id,tag_id' }); okIds.forEach(cid => runWorkflows('tag_added', { sub_account_id: body.sub_account_id, portal_id: acc.portal_id, contact_id: cid, tag_id: body.tag_id })); }
                return res.status(200).json({ success: true, affected: okIds.length });
            }
            if (op === 'remove_tag' && body.tag_id) { await supabase.from('crm_contact_tags').delete().eq('tag_id', body.tag_id).in('contact_id', okIds); return res.status(200).json({ success: true, affected: okIds.length }); }
            return res.status(400).json({ success: false, message: 'Unknown bulk op.' });
        }

        // Import contacts from parsed CSV rows (client parses the file → array of {header:value}).
        if (action === 'import_contacts') {
            const acc = await subAccess(personId, body.sub_account_id, 'contacts');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const rows = Array.isArray(body.rows) ? body.rows : [];
            if (!rows.length) return res.status(400).json({ success: false, message: 'No rows to import.' });
            if (rows.length > 5000) return res.status(400).json({ success: false, message: 'Please import 5000 or fewer rows at a time.' });
            const map = body.mapping || {}; // { first_name:'First Name', ... } header names
            let created = 0, skipped = 0;
            const dedupe = body.dedupe_by_email !== false;
            const toInsert = [];
            for (const r of rows) {
                const row = { sub_account_id: body.sub_account_id, portal_id: acc.portal_id, created_by: personId, status: 'active', owner_person_id: personId, custom: {} };
                CONTACT_FIELDS.forEach(k => { const hdr = map[k]; if (hdr && r[hdr] != null && r[hdr] !== '') row[k] = String(r[hdr]); });
                if (!row.first_name && !row.last_name && !row.email && !row.phone && !row.company) { skipped++; continue; }
                toInsert.push(row);
            }
            // Dedupe by email within this CRM (skip existing).
            if (dedupe) {
                const emails = toInsert.map(r => (r.email || '').toLowerCase()).filter(Boolean);
                if (emails.length) {
                    const { data: existing } = await supabase.from('crm_contacts').select('email').eq('sub_account_id', body.sub_account_id).in('email', emails);
                    const have = new Set((existing || []).map(e => (e.email || '').toLowerCase()));
                    for (let i = toInsert.length - 1; i >= 0; i--) { const em = (toInsert[i].email || '').toLowerCase(); if (em && have.has(em)) { toInsert.splice(i, 1); skipped++; } }
                }
            }
            // Insert in chunks.
            for (let i = 0; i < toInsert.length; i += 500) {
                const chunk = toInsert.slice(i, i + 500);
                const { error } = await supabase.from('crm_contacts').insert(chunk);
                if (!error) created += chunk.length;
            }
            return res.status(200).json({ success: true, created, skipped });
        }

        if (action === 'create_contact') {
            const acc = await subAccess(personId, body.sub_account_id, 'contacts');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const f = body.contact || {};
            const row = { sub_account_id: body.sub_account_id, portal_id: acc.portal_id, created_by: personId };
            CONTACT_FIELDS.forEach(k => { row[k] = (f[k] === '' || f[k] === undefined) ? null : f[k]; });
            if (!row.status) row.status = 'active';
            row.owner_person_id = f.owner_person_id || personId; // default: assigned to creator
            if (body.custom && typeof body.custom === 'object') row.custom = body.custom;
            const { data, error } = await supabase.from('crm_contacts').insert(row).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not create contact.' });
            if (Array.isArray(body.tag_ids)) await applyTags(data.id, data.sub_account_id, body.tag_ids);
            runWorkflows('contact_created', { sub_account_id: data.sub_account_id, portal_id: acc.portal_id, contact_id: data.id });
            return res.status(200).json({ success: true, contact: data });
        }

        if (action === 'update_contact') {
            const ca = await contactAccess(body.id, 'contacts');
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const f = body.contact || {};
            const patch = {};
            CONTACT_FIELDS.forEach(k => { if (k in f) patch[k] = f[k] === '' ? null : f[k]; });
            if ('owner_person_id' in f) patch.owner_person_id = f.owner_person_id || null;
            if (body.custom && typeof body.custom === 'object') patch.custom = body.custom;
            const { data, error } = await supabase.from('crm_contacts').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update contact.' });
            if (Array.isArray(body.tag_ids)) await applyTags(body.id, ca.contact.sub_account_id, body.tag_ids);
            return res.status(200).json({ success: true, contact: data });
        }

        if (action === 'delete_contact') {
            const ca = await contactAccess(body.id, 'contacts');
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            await supabase.from('crm_contacts').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        // ── TAGS ─────────────────────────────────────────────────────────────
        if (action === 'list_tags') {
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data } = await supabase.from('crm_tags').select('*').eq('sub_account_id', body.sub_account_id).order('name');
            return res.status(200).json({ success: true, tags: data || [] });
        }

        if (action === 'create_tag') {
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const name = (body.name || '').trim();
            if (!name) return res.status(400).json({ success: false, message: 'Tag name required.' });
            const { data, error } = await supabase.from('crm_tags')
                .insert({ sub_account_id: body.sub_account_id, portal_id: acc.portal_id, name, color: body.color || null })
                .select('*').single();
            if (error) { // likely a duplicate (unique per CRM) → return the existing tag
                const { data: ex } = await supabase.from('crm_tags').select('*').eq('sub_account_id', body.sub_account_id).ilike('name', name).maybeSingle();
                if (ex) return res.status(200).json({ success: true, tag: ex });
                return res.status(500).json({ success: false, message: 'Could not create tag.' });
            }
            return res.status(200).json({ success: true, tag: data });
        }

        if (action === 'set_contact_tags') {
            const ca = await contactAccess(body.contact_id, 'contacts');
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const applied = await applyTags(body.contact_id, ca.contact.sub_account_id, body.tag_ids || []);
            applied.forEach(tid => runWorkflows('tag_added', { sub_account_id: ca.contact.sub_account_id, portal_id: ca.portal_id, contact_id: body.contact_id, tag_id: tid }));
            return res.status(200).json({ success: true, tag_ids: applied });
        }

        // ── CONTACT RECORD (detail + notes + tasks) ──────────────────────────
        if (action === 'get_contact') {
            const ca = await contactAccess(body.id, 'contacts');
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const cid = body.id;
            const [tagsRes, oppsRes, notesRes, tasksRes, msgsRes, apptsRes] = await Promise.all([
                supabase.from('crm_contact_tags').select('crm_tags(id,name,color)').eq('contact_id', cid),
                supabase.from('crm_opportunities').select('*').eq('contact_id', cid).order('created_at', { ascending: false }),
                supabase.from('crm_notes').select('*').eq('contact_id', cid).order('created_at', { ascending: false }),
                supabase.from('crm_tasks').select('*').eq('contact_id', cid).order('done', { ascending: true }).order('due_date', { ascending: true }).order('created_at', { ascending: false }),
                supabase.from('crm_messages').select('*').eq('contact_id', cid).order('created_at', { ascending: false }).limit(100),
                supabase.from('crm_appointments').select('*').eq('contact_id', cid).order('starts_at', { ascending: false }).limit(50)
            ]);
            const tags = (tagsRes.data || []).map(t => t.crm_tags).filter(Boolean);
            return res.status(200).json({ success: true, contact: { ...ca.contact, tags }, opportunities: oppsRes.data || [], notes: notesRes.data || [], tasks: tasksRes.data || [], messages: msgsRes.data || [], appointments: apptsRes.data || [] });
        }

        if (action === 'add_note') {
            const ca = await contactAccess(body.contact_id, 'contacts');
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const bodyText = (body.body || '').trim();
            if (!bodyText) return res.status(400).json({ success: false, message: 'Note is empty.' });
            const { data, error } = await supabase.from('crm_notes').insert({ sub_account_id: ca.contact.sub_account_id, portal_id: ca.portal_id, contact_id: body.contact_id, body: bodyText, created_by: personId }).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not add note.' });
            return res.status(200).json({ success: true, note: data });
        }
        if (action === 'delete_note') {
            const { data: n } = await supabase.from('crm_notes').select('contact_id').eq('id', body.id).maybeSingle();
            if (!n) return res.status(404).json({ success: false, message: 'Note not found.' });
            const ca = await contactAccess(n.contact_id, 'contacts');
            if (!ca) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_notes').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        if (action === 'add_task') {
            const ca = await contactAccess(body.contact_id, 'contacts');
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const title = (body.title || '').trim();
            if (!title) return res.status(400).json({ success: false, message: 'Task title required.' });
            const { data, error } = await supabase.from('crm_tasks').insert({ sub_account_id: ca.contact.sub_account_id, portal_id: ca.portal_id, contact_id: body.contact_id, title, due_date: body.due_date || null, assignee_person_id: body.assignee_person_id || personId, created_by: personId }).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not add task.' });
            return res.status(200).json({ success: true, task: data });
        }
        // Standalone task (not tied to a contact) — for the global Tasks view.
        if (action === 'add_task_std') {
            const acc = await subAccess(personId, body.sub_account_id, 'contacts');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const title = (body.title || '').trim();
            if (!title) return res.status(400).json({ success: false, message: 'Task title required.' });
            const { data, error } = await supabase.from('crm_tasks').insert({ sub_account_id: body.sub_account_id, portal_id: acc.portal_id, contact_id: body.contact_id || null, title, due_date: body.due_date || null, assignee_person_id: body.assignee_person_id || personId, created_by: personId }).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not add task.' });
            return res.status(200).json({ success: true, task: data });
        }
        if (action === 'update_task') {
            const { data: t } = await supabase.from('crm_tasks').select('*').eq('id', body.id).maybeSingle();
            if (!t) return res.status(404).json({ success: false, message: 'Task not found.' });
            const acc = await subAccess(personId, t.sub_account_id, 'contacts');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const patch = {};
            if ('title' in body && (body.title || '').trim()) patch.title = body.title.trim();
            if ('due_date' in body) patch.due_date = body.due_date || null;
            if ('assignee_person_id' in body) patch.assignee_person_id = body.assignee_person_id || null;
            if ('done' in body) { patch.done = !!body.done; patch.done_at = body.done ? new Date().toISOString() : null; }
            const { data, error } = await supabase.from('crm_tasks').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update task.' });
            return res.status(200).json({ success: true, task: data });
        }
        // Global task list across the CRM (with optional filters).
        if (action === 'list_all_tasks') {
            const acc = await subAccess(personId, body.sub_account_id, 'contacts');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            let q = supabase.from('crm_tasks').select('*').eq('sub_account_id', body.sub_account_id);
            if (body.mine) q = q.eq('assignee_person_id', personId);
            else if (body.assignee_person_id) q = q.eq('assignee_person_id', body.assignee_person_id);
            const { data: tasks } = await q.order('due_date', { ascending: true, nullsFirst: false }).limit(2000);
            let list = tasks || [];
            const cids = [...new Set(list.map(t => t.contact_id).filter(Boolean))];
            const cmap = {};
            if (cids.length) { const { data: cs } = await supabase.from('crm_contacts').select('id, first_name, last_name, email').in('id', cids); (cs || []).forEach(c => cmap[c.id] = c); }
            list = list.map(t => ({ ...t, contact: t.contact_id ? (cmap[t.contact_id] || null) : null }));
            return res.status(200).json({ success: true, tasks: list, me: personId });
        }
        if (action === 'delete_task') {
            const { data: t } = await supabase.from('crm_tasks').select('sub_account_id').eq('id', body.id).maybeSingle();
            if (!t) return res.status(404).json({ success: false, message: 'Task not found.' });
            const acc = await subAccess(personId, t.sub_account_id, 'contacts');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_tasks').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        // ── OPPORTUNITIES / PIPELINE ─────────────────────────────────────────
        async function oppAccess(oppId, area) {
            const { data: o } = await supabase.from('crm_opportunities').select('*').eq('id', oppId).maybeSingle();
            if (!o) return null;
            const acc = await subAccess(personId, o.sub_account_id, area);
            if (!acc) return null;
            return { opp: o, portal_id: acc.portal_id };
        }

        if (action === 'get_pipeline') {
            const acc = await subAccess(personId, body.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            // Lazily seed a default pipeline (New/Contacted/.../Won/Lost) on first view.
            const { data: pid0 } = await supabase.rpc('crm_ensure_default_pipeline', { p_sub: body.sub_account_id });
            let pid = pid0;
            if (body.pipeline_id) { const { data: chk } = await supabase.from('crm_pipelines').select('id').eq('id', body.pipeline_id).eq('sub_account_id', body.sub_account_id).maybeSingle(); if (chk) pid = chk.id; }
            const { data: pipeline } = await supabase.from('crm_pipelines').select('*').eq('id', pid).maybeSingle();
            const { data: stages } = await supabase.from('crm_pipeline_stages').select('*').eq('pipeline_id', pid).order('position', { ascending: true });
            return res.status(200).json({ success: true, pipeline, stages: stages || [] });
        }
        if (action === 'list_pipelines') {
            const acc = await subAccess(personId, body.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            await supabase.rpc('crm_ensure_default_pipeline', { p_sub: body.sub_account_id });
            const { data: pipelines } = await supabase.from('crm_pipelines').select('*').eq('sub_account_id', body.sub_account_id).order('created_at', { ascending: true });
            return res.status(200).json({ success: true, pipelines: pipelines || [] });
        }
        if (action === 'create_pipeline') {
            const acc = await subAccess(personId, body.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const name = (body.name || '').trim(); if (!name) return res.status(400).json({ success: false, message: 'Pipeline name required.' });
            const { data: p, error } = await supabase.from('crm_pipelines').insert({ sub_account_id: body.sub_account_id, portal_id: acc.portal_id, name }).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not create pipeline.' });
            const seed = [['New', 0, false, false], ['Contacted', 1, false, false], ['Qualified', 2, false, false], ['Won', 3, true, false], ['Lost', 4, false, true]];
            await supabase.from('crm_pipeline_stages').insert(seed.map(s => ({ sub_account_id: body.sub_account_id, pipeline_id: p.id, name: s[0], position: s[1], is_won: s[2], is_lost: s[3] })));
            return res.status(200).json({ success: true, pipeline: p });
        }
        if (action === 'update_pipeline') {
            const { data: p } = await supabase.from('crm_pipelines').select('sub_account_id').eq('id', body.id).maybeSingle();
            if (!p) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, p.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_pipelines').update({ name: (body.name || '').trim() || 'Pipeline' }).eq('id', body.id);
            return res.status(200).json({ success: true });
        }
        if (action === 'delete_pipeline') {
            const { data: p } = await supabase.from('crm_pipelines').select('sub_account_id').eq('id', body.id).maybeSingle();
            if (!p) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, p.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const { count } = await supabase.from('crm_pipelines').select('id', { count: 'exact', head: true }).eq('sub_account_id', p.sub_account_id);
            if ((count || 0) <= 1) return res.status(400).json({ success: false, message: 'You need at least one pipeline.' });
            const { count: oc } = await supabase.from('crm_opportunities').select('id', { count: 'exact', head: true }).eq('pipeline_id', body.id);
            if (oc) return res.status(400).json({ success: false, message: 'Move or delete this pipeline’s deals first.' });
            await supabase.from('crm_pipeline_stages').delete().eq('pipeline_id', body.id);
            await supabase.from('crm_pipelines').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }
        if (action === 'add_stage') {
            const { data: p } = await supabase.from('crm_pipelines').select('sub_account_id').eq('id', body.pipeline_id).maybeSingle();
            if (!p) return res.status(404).json({ success: false, message: 'Pipeline not found.' });
            const acc = await subAccess(personId, p.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const { data: last } = await supabase.from('crm_pipeline_stages').select('position').eq('pipeline_id', body.pipeline_id).order('position', { ascending: false }).limit(1);
            const pos = (last && last[0] ? (last[0].position || 0) : 0) + 1;
            const { data, error } = await supabase.from('crm_pipeline_stages').insert({ sub_account_id: p.sub_account_id, pipeline_id: body.pipeline_id, name: (body.name || 'Stage').trim(), position: pos, is_won: !!body.is_won, is_lost: !!body.is_lost }).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not add stage.' });
            return res.status(200).json({ success: true, stage: data });
        }
        if (action === 'update_stage') {
            const { data: st } = await supabase.from('crm_pipeline_stages').select('sub_account_id').eq('id', body.id).maybeSingle();
            if (!st) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, st.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const patch = {};
            if ('name' in body) patch.name = (body.name || 'Stage').trim();
            if ('is_won' in body) patch.is_won = !!body.is_won;
            if ('is_lost' in body) patch.is_lost = !!body.is_lost;
            await supabase.from('crm_pipeline_stages').update(patch).eq('id', body.id);
            return res.status(200).json({ success: true });
        }
        if (action === 'delete_stage') {
            const { data: st } = await supabase.from('crm_pipeline_stages').select('sub_account_id, pipeline_id').eq('id', body.id).maybeSingle();
            if (!st) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, st.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const { count } = await supabase.from('crm_pipeline_stages').select('id', { count: 'exact', head: true }).eq('pipeline_id', st.pipeline_id);
            if ((count || 0) <= 1) return res.status(400).json({ success: false, message: 'A pipeline needs at least one stage.' });
            const { count: oc } = await supabase.from('crm_opportunities').select('id', { count: 'exact', head: true }).eq('stage_id', body.id);
            if (oc) return res.status(400).json({ success: false, message: 'Move this stage’s deals first.' });
            await supabase.from('crm_pipeline_stages').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }
        if (action === 'reorder_stages') {
            const ids = Array.isArray(body.stage_ids) ? body.stage_ids : [];
            if (!body.pipeline_id || !ids.length) return res.status(400).json({ success: false, message: 'Nothing to reorder.' });
            const { data: p } = await supabase.from('crm_pipelines').select('sub_account_id').eq('id', body.pipeline_id).maybeSingle();
            if (!p) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, p.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            for (let i = 0; i < ids.length; i++) await supabase.from('crm_pipeline_stages').update({ position: i }).eq('id', ids[i]).eq('pipeline_id', body.pipeline_id);
            return res.status(200).json({ success: true });
        }

        if (action === 'list_opportunities') {
            const acc = await subAccess(personId, body.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            let oq = supabase.from('crm_opportunities').select('*').eq('sub_account_id', body.sub_account_id);
            if (body.pipeline_id) oq = oq.eq('pipeline_id', body.pipeline_id);
            const oown = assignedFilter(acc); if (oown) oq = oq.eq('owner_person_id', oown);
            const { data: opps } = await oq.order('position', { ascending: true }).order('created_at', { ascending: true }).limit(2000);
            const list = opps || [];
            const cids = [...new Set(list.map(o => o.contact_id).filter(Boolean))];
            const cmap = {};
            if (cids.length) {
                const { data: cs } = await supabase.from('crm_contacts').select('id, first_name, last_name, email, company').in('id', cids);
                (cs || []).forEach(c => { cmap[c.id] = c; });
            }
            const withContact = list.map(o => ({ ...o, contact: o.contact_id ? (cmap[o.contact_id] || null) : null }));
            return res.status(200).json({ success: true, opportunities: withContact });
        }

        if (action === 'create_opportunity') {
            const acc = await subAccess(personId, body.sub_account_id, 'opportunities');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const o = body.opp || {};
            const title = (o.title || '').trim();
            if (!title) return res.status(400).json({ success: false, message: 'Deal title required.' });
            let pid = o.pipeline_id;
            if (pid) { const { data: chk } = await supabase.from('crm_pipelines').select('id').eq('id', pid).eq('sub_account_id', body.sub_account_id).maybeSingle(); if (!chk) pid = null; }
            if (!pid) { const { data: dpid } = await supabase.rpc('crm_ensure_default_pipeline', { p_sub: body.sub_account_id }); pid = dpid; }
            let stageId = o.stage_id;
            if (!stageId) { const { data: st } = await supabase.from('crm_pipeline_stages').select('id').eq('pipeline_id', pid).order('position').limit(1); stageId = st && st[0] && st[0].id; }
            // place at the end of its stage
            const { data: last } = await supabase.from('crm_opportunities').select('position').eq('sub_account_id', body.sub_account_id).eq('stage_id', stageId).order('position', { ascending: false }).limit(1);
            const pos = (last && last[0] ? (last[0].position || 0) : 0) + 1;
            const row = {
                sub_account_id: body.sub_account_id, portal_id: acc.portal_id, pipeline_id: pid, stage_id: stageId,
                contact_id: o.contact_id || null, title, value_cents: Math.round(Number(o.value || 0) * 100) || 0,
                status: o.status || 'open', expected_close_date: o.expected_close_date || null, notes: o.notes || null,
                owner_person_id: o.owner_person_id || personId, position: pos, created_by: personId
            };
            const { data, error } = await supabase.from('crm_opportunities').insert(row).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not create deal.' });
            return res.status(200).json({ success: true, opportunity: data });
        }

        if (action === 'update_opportunity') {
            const oa = await oppAccess(body.id, 'opportunities');
            if (!oa) return res.status(403).json({ success: false, message: 'No access to this deal.' });
            const o = body.opp || {};
            const patch = {};
            if ('title' in o) patch.title = (o.title || '').trim() || oa.opp.title;
            if ('contact_id' in o) patch.contact_id = o.contact_id || null;
            if ('value' in o) patch.value_cents = Math.round(Number(o.value || 0) * 100) || 0;
            if ('stage_id' in o) patch.stage_id = o.stage_id || null;
            if ('status' in o) patch.status = o.status;
            if ('expected_close_date' in o) patch.expected_close_date = o.expected_close_date || null;
            if ('notes' in o) patch.notes = o.notes === '' ? null : o.notes;
            if ('owner_person_id' in o) patch.owner_person_id = o.owner_person_id || null;
            const { data, error } = await supabase.from('crm_opportunities').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update deal.' });
            return res.status(200).json({ success: true, opportunity: data });
        }

        // Drag a deal to another stage; status follows the stage's won/lost flag.
        if (action === 'move_opportunity') {
            const oa = await oppAccess(body.id, 'opportunities');
            if (!oa) return res.status(403).json({ success: false, message: 'No access to this deal.' });
            const { data: stage } = await supabase.from('crm_pipeline_stages').select('*').eq('id', body.stage_id).maybeSingle();
            if (!stage || stage.sub_account_id !== oa.opp.sub_account_id) return res.status(400).json({ success: false, message: 'Invalid stage.' });
            const status = stage.is_won ? 'won' : (stage.is_lost ? 'lost' : 'open');
            const patch = { stage_id: body.stage_id, status };
            if (body.position != null) patch.position = Number(body.position) || 0;
            const { data, error } = await supabase.from('crm_opportunities').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not move deal.' });
            return res.status(200).json({ success: true, opportunity: data });
        }

        if (action === 'delete_opportunity') {
            const oa = await oppAccess(body.id, 'opportunities');
            if (!oa) return res.status(403).json({ success: false, message: 'No access to this deal.' });
            await supabase.from('crm_opportunities').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        // ── CUSTOM FIELD DEFINITIONS ─────────────────────────────────────────
        if (action === 'list_custom_fields') {
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const entity = body.entity || 'contact';
            const { data } = await supabase.from('crm_custom_fields')
                .select('*').eq('sub_account_id', body.sub_account_id).eq('entity', entity)
                .order('position', { ascending: true }).order('created_at', { ascending: true });
            return res.status(200).json({ success: true, fields: data || [] });
        }

        if (action === 'create_custom_field') {
            const acc = await subAccess(personId, body.sub_account_id, 'crm_settings');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const f = body.field || {};
            const label = (f.label || '').trim();
            if (!label) return res.status(400).json({ success: false, message: 'Field label required.' });
            const type = FIELD_TYPES.includes(f.type) ? f.type : 'text';
            const entity = body.entity || 'contact';
            let key = slugify(f.field_key || label);
            // ensure unique key within this CRM/entity
            const { data: existing } = await supabase.from('crm_custom_fields').select('field_key').eq('sub_account_id', body.sub_account_id).eq('entity', entity);
            const used = new Set((existing || []).map(x => x.field_key));
            if (used.has(key)) { let i = 2; while (used.has(key + '_' + i)) i++; key = key + '_' + i; }
            const options = Array.isArray(f.options) ? f.options.filter(Boolean).map(String) : [];
            const row = { sub_account_id: body.sub_account_id, portal_id: acc.portal_id, entity, label, field_key: key, type, options, required: !!f.required, position: Number(f.position) || 0 };
            const { data, error } = await supabase.from('crm_custom_fields').insert(row).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not create field.' });
            return res.status(200).json({ success: true, field: data });
        }

        if (action === 'update_custom_field') {
            const { data: fld } = await supabase.from('crm_custom_fields').select('*').eq('id', body.id).maybeSingle();
            if (!fld) return res.status(404).json({ success: false, message: 'Field not found.' });
            const acc = await subAccess(personId, fld.sub_account_id, 'crm_settings');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const f = body.field || {};
            const patch = {};
            if ('label' in f) patch.label = (f.label || '').trim() || fld.label;
            if ('type' in f && FIELD_TYPES.includes(f.type)) patch.type = f.type;
            if ('options' in f) patch.options = Array.isArray(f.options) ? f.options.filter(Boolean).map(String) : [];
            if ('required' in f) patch.required = !!f.required;
            if ('position' in f) patch.position = Number(f.position) || 0;
            const { data, error } = await supabase.from('crm_custom_fields').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update field.' });
            return res.status(200).json({ success: true, field: data });
        }

        if (action === 'delete_custom_field') {
            const { data: fld } = await supabase.from('crm_custom_fields').select('*').eq('id', body.id).maybeSingle();
            if (!fld) return res.status(404).json({ success: false, message: 'Field not found.' });
            const acc = await subAccess(personId, fld.sub_account_id, 'crm_settings');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_custom_fields').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        // ── TAG MANAGEMENT (rename / recolor / delete) ───────────────────────
        if (action === 'update_tag') {
            const { data: tag } = await supabase.from('crm_tags').select('*').eq('id', body.id).maybeSingle();
            if (!tag) return res.status(404).json({ success: false, message: 'Tag not found.' });
            const acc = await subAccess(personId, tag.sub_account_id, 'crm_settings');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const patch = {};
            if ('name' in body && (body.name || '').trim()) patch.name = body.name.trim();
            if ('color' in body) patch.color = body.color || null;
            const { data, error } = await supabase.from('crm_tags').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update tag (name may already exist).' });
            return res.status(200).json({ success: true, tag: data });
        }

        if (action === 'delete_tag') {
            const { data: tag } = await supabase.from('crm_tags').select('*').eq('id', body.id).maybeSingle();
            if (!tag) return res.status(404).json({ success: false, message: 'Tag not found.' });
            const acc = await subAccess(personId, tag.sub_account_id, 'crm_settings');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_tags').delete().eq('id', body.id); // contact links cascade
            return res.status(200).json({ success: true });
        }

        // ── CONVERSATIONS (per-contact message/activity log) ─────────────────
        if (action === 'add_message') {
            const ca = await contactAccess(body.contact_id, 'conversations');
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const text = (body.body || '').trim();
            if (!text) return res.status(400).json({ success: false, message: 'Message is empty.' });
            const dir = body.direction === 'inbound' ? 'inbound' : 'outbound';
            const chan = ['note', 'call', 'email', 'sms'].includes(body.channel) ? body.channel : 'note';
            const { data, error } = await supabase.from('crm_messages').insert({ sub_account_id: ca.contact.sub_account_id, portal_id: ca.portal_id, contact_id: body.contact_id, direction: dir, channel: chan, body: text, created_by: personId }).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not log message.' });
            return res.status(200).json({ success: true, message_row: data });
        }
        if (action === 'delete_message') {
            const { data: m } = await supabase.from('crm_messages').select('contact_id').eq('id', body.id).maybeSingle();
            if (!m) return res.status(404).json({ success: false, message: 'Not found.' });
            const ca = await contactAccess(m.contact_id, 'conversations');
            if (!ca) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_messages').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }
        if (action === 'list_conversations') {
            const acc = await subAccess(personId, body.sub_account_id, 'conversations');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data: msgs } = await supabase.from('crm_messages').select('*').eq('sub_account_id', body.sub_account_id).order('created_at', { ascending: false }).limit(500);
            const list = msgs || [];
            const seen = {}; const threads = [];
            list.forEach(m => { if (!seen[m.contact_id]) { seen[m.contact_id] = { contact_id: m.contact_id, last: m, count: 0 }; threads.push(seen[m.contact_id]); } seen[m.contact_id].count++; });
            const cids = threads.map(t => t.contact_id);
            const cmap = {};
            if (cids.length) { const { data: cs } = await supabase.from('crm_contacts').select('id, first_name, last_name, email, company').in('id', cids); (cs || []).forEach(c => cmap[c.id] = c); }
            threads.forEach(t => { t.contact = cmap[t.contact_id] || null; });
            return res.status(200).json({ success: true, threads });
        }

        // ── CALENDARS (appointments) ─────────────────────────────────────────
        if (action === 'list_appointments') {
            const acc = await subAccess(personId, body.sub_account_id, 'calendars');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data: appts } = await supabase.from('crm_appointments').select('*').eq('sub_account_id', body.sub_account_id).order('starts_at', { ascending: true }).limit(1000);
            const list = appts || [];
            const cids = [...new Set(list.map(a => a.contact_id).filter(Boolean))];
            const cmap = {};
            if (cids.length) { const { data: cs } = await supabase.from('crm_contacts').select('id, first_name, last_name, company').in('id', cids); (cs || []).forEach(c => cmap[c.id] = c); }
            return res.status(200).json({ success: true, appointments: list.map(a => ({ ...a, contact: a.contact_id ? (cmap[a.contact_id] || null) : null })) });
        }
        if (action === 'create_appointment') {
            const acc = await subAccess(personId, body.sub_account_id, 'calendars');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const a = body.appt || {};
            const title = (a.title || '').trim();
            if (!title) return res.status(400).json({ success: false, message: 'Title required.' });
            if (!a.starts_at) return res.status(400).json({ success: false, message: 'Start time required.' });
            const row = { sub_account_id: body.sub_account_id, portal_id: acc.portal_id, contact_id: a.contact_id || null, title, starts_at: a.starts_at, ends_at: a.ends_at || null, location: a.location || null, notes: a.notes || null, created_by: personId };
            const { data, error } = await supabase.from('crm_appointments').insert(row).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not create appointment.' });
            return res.status(200).json({ success: true, appointment: data });
        }
        if (action === 'update_appointment') {
            const { data: ap } = await supabase.from('crm_appointments').select('*').eq('id', body.id).maybeSingle();
            if (!ap) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, ap.sub_account_id, 'calendars');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const a = body.appt || {};
            const patch = {};
            ['title', 'starts_at', 'ends_at', 'location', 'notes', 'status', 'contact_id'].forEach(k => { if (k in a) patch[k] = a[k] === '' ? null : a[k]; });
            const { data, error } = await supabase.from('crm_appointments').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update.' });
            return res.status(200).json({ success: true, appointment: data });
        }
        if (action === 'delete_appointment') {
            const { data: ap } = await supabase.from('crm_appointments').select('sub_account_id').eq('id', body.id).maybeSingle();
            if (!ap) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, ap.sub_account_id, 'calendars');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_appointments').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        // ── BOOKING CALENDARS (HighLevel-style scheduling pages) ─────────────
        if (action === 'list_calendars') {
            const acc = await subAccess(personId, body.sub_account_id, 'calendars');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data } = await supabase.from('crm_calendars').select('*').eq('sub_account_id', body.sub_account_id).order('created_at', { ascending: false });
            return res.status(200).json({ success: true, calendars: data || [] });
        }
        if (action === 'get_calendar') {
            const { data: cal } = await supabase.from('crm_calendars').select('*').eq('id', body.id).maybeSingle();
            if (!cal) return res.status(404).json({ success: false, message: 'Calendar not found.' });
            const acc = await subAccess(personId, cal.sub_account_id, 'calendars');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            return res.status(200).json({ success: true, calendar: cal });
        }
        if (action === 'create_calendar' || action === 'update_calendar') {
            let acc, subId2, existing = null;
            if (action === 'update_calendar') {
                const { data: cal } = await supabase.from('crm_calendars').select('*').eq('id', body.id).maybeSingle();
                if (!cal) return res.status(404).json({ success: false, message: 'Calendar not found.' });
                existing = cal; subId2 = cal.sub_account_id;
            } else { subId2 = body.sub_account_id; }
            acc = await subAccess(personId, subId2, 'calendars');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const c = body.calendar || {};
            const patch = {};
            if ('name' in c) { const nm = String(c.name || '').trim(); if (!nm) return res.status(400).json({ success: false, message: 'Name required.' }); patch.name = nm; }
            if ('description' in c) patch.description = c.description || null;
            if ('type' in c) patch.type = ['individual', 'round_robin', 'collective'].includes(c.type) ? c.type : 'individual';
            ['duration_min', 'buffer_before_min', 'buffer_after_min', 'min_notice_min', 'date_range_days'].forEach(k => { if (k in c) patch[k] = Math.max(0, parseInt(c[k], 10) || 0); });
            if ('timezone' in c) patch.timezone = String(c.timezone || 'America/New_York');
            if ('availability' in c && c.availability && typeof c.availability === 'object') patch.availability = c.availability;
            if ('location_type' in c) patch.location_type = ['in_person', 'phone', 'video', 'custom'].includes(c.location_type) ? c.location_type : 'custom';
            if ('location_value' in c) patch.location_value = c.location_value || null;
            if ('host_person_ids' in c && Array.isArray(c.host_person_ids)) patch.host_person_ids = c.host_person_ids;
            if ('template' in c) patch.template = String(c.template || 'classic').slice(0, 40);
            if ('color_primary' in c) patch.color_primary = /^#[0-9a-fA-F]{6}$/.test(c.color_primary) ? c.color_primary : '#0d9488';
            if ('color_accent' in c) patch.color_accent = /^#[0-9a-fA-F]{6}$/.test(c.color_accent) ? c.color_accent : '#0f766e';
            if ('confirmation_message' in c) patch.confirmation_message = c.confirmation_message || null;
            if ('active' in c) patch.active = !!c.active;
            if (action === 'create_calendar') {
                // Unique slug per CRM from the name.
                let base = slugify(patch.name || 'calendar'), slug = base, n = 2;
                while (true) { const { data: hit } = await supabase.from('crm_calendars').select('id').eq('sub_account_id', subId2).eq('slug', slug).maybeSingle(); if (!hit) break; slug = base + '-' + (n++); }
                const row = Object.assign({ sub_account_id: subId2, portal_id: acc.portal_id, slug, created_by: personId }, patch);
                const { data, error } = await supabase.from('crm_calendars').insert(row).select('*').single();
                if (error) return res.status(500).json({ success: false, message: 'Could not create calendar.' });
                return res.status(200).json({ success: true, calendar: data });
            } else {
                patch.updated_at = new Date().toISOString();
                const { data, error } = await supabase.from('crm_calendars').update(patch).eq('id', body.id).select('*').single();
                if (error) return res.status(500).json({ success: false, message: 'Could not update calendar.' });
                return res.status(200).json({ success: true, calendar: data });
            }
        }
        if (action === 'delete_calendar') {
            const { data: cal } = await supabase.from('crm_calendars').select('sub_account_id').eq('id', body.id).maybeSingle();
            if (!cal) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, cal.sub_account_id, 'calendars');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_calendars').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }
        if (action === 'list_calendar_bookings') {
            const { data: cal } = await supabase.from('crm_calendars').select('sub_account_id').eq('id', body.calendar_id).maybeSingle();
            if (!cal) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, cal.sub_account_id, 'calendars');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const { data } = await supabase.from('crm_appointments').select('*, crm_contacts(first_name,last_name,email,phone)').eq('calendar_id', body.calendar_id).order('starts_at', { ascending: false }).limit(200);
            return res.status(200).json({ success: true, bookings: (data || []).map(b => ({ ...b, contact: b.crm_contacts || null })) });
        }

        // ── AGENCY-WIDE CALENDAR (mix bookings across every CRM the person can see) ──
        if (action === 'agency_calendar') {
            const portalId = body.portal_id;
            if (!portalId) return res.status(400).json({ success: false, message: 'Missing agency.' });
            const god = await isGod(personId);
            const { data: subs } = await supabase.from('agency_sub_accounts').select('id, name, company_id').eq('portal_id', portalId).order('created_at');
            let allowed = [];
            if (god) allowed = (subs || []).map(s => s.id);
            else {
                const { data: mem } = await supabase.from('partner_portal_members').select('role, scope').eq('portal_id', portalId).eq('person_id', personId).maybeSingle();
                if (!mem) return res.status(403).json({ success: false, message: 'No access to this agency.' });
                if (mem.role === 'owner' || mem.role === 'agency_admin') allowed = (subs || []).map(s => s.id);
                else { const g = (mem.scope && Array.isArray(mem.scope.sub_account_ids)) ? mem.scope.sub_account_ids : []; allowed = (subs || []).map(s => s.id).filter(id => g.includes(id)); }
            }
            const subMap = {}; (subs || []).forEach(s => subMap[s.id] = s.name);
            if (!allowed.length) return res.status(200).json({ success: true, events: [], sub_accounts: [] });
            const since = new Date(Date.now() - 7 * 86400000).toISOString();
            const { data: appts } = await supabase.from('crm_appointments')
                .select('id, sub_account_id, calendar_id, title, starts_at, ends_at, location, status, attendee_name, attendee_email, crm_contacts(first_name,last_name,email), crm_calendars(name,color_primary)')
                .in('sub_account_id', allowed).gte('starts_at', since).order('starts_at', { ascending: true }).limit(1000);
            const events = (appts || []).map(a => ({
                id: a.id, sub_account_id: a.sub_account_id, crm_name: subMap[a.sub_account_id] || 'CRM',
                title: a.title, starts_at: a.starts_at, ends_at: a.ends_at, location: a.location, status: a.status,
                who: a.attendee_name || (a.crm_contacts ? [a.crm_contacts.first_name, a.crm_contacts.last_name].filter(Boolean).join(' ') : '') || a.attendee_email || '',
                calendar_name: a.crm_calendars ? a.crm_calendars.name : null,
                color: (a.crm_calendars && a.crm_calendars.color_primary) || '#0d9488'
            }));
            return res.status(200).json({ success: true, events, sub_accounts: allowed.map(id => ({ id, name: subMap[id] })) });
        }

        // ── REPORTING (aggregates from this CRM's own data) ──────────────────
        // Open tasks across the CRM (for the Dashboard "tasks due" list).
        if (action === 'list_tasks') {
            const acc = await subAccess(personId, body.sub_account_id, 'contacts');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data: tasks } = await supabase.from('crm_tasks').select('*').eq('sub_account_id', body.sub_account_id).eq('done', false).order('due_date', { ascending: true, nullsFirst: false }).order('created_at', { ascending: false }).limit(50);
            const list = tasks || [];
            const cids = [...new Set(list.map(t => t.contact_id).filter(Boolean))];
            const cmap = {};
            if (cids.length) { const { data: cs } = await supabase.from('crm_contacts').select('id, first_name, last_name, email').in('id', cids); (cs || []).forEach(c => cmap[c.id] = c); }
            return res.status(200).json({ success: true, tasks: list.map(t => ({ ...t, contact: t.contact_id ? (cmap[t.contact_id] || null) : null })) });
        }

        if (action === 'get_report') {
            const acc = await subAccess(personId, body.sub_account_id, 'reporting');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const sub = body.sub_account_id;
            const [contactsC, oppsRes, stagesRes, tasksRes, formsRes] = await Promise.all([
                supabase.from('crm_contacts').select('id', { count: 'exact', head: true }).eq('sub_account_id', sub),
                supabase.from('crm_opportunities').select('stage_id,status,value_cents').eq('sub_account_id', sub),
                supabase.from('crm_pipeline_stages').select('id,name,position,is_won,is_lost').eq('sub_account_id', sub).order('position', { ascending: true }),
                supabase.from('crm_tasks').select('done,due_date').eq('sub_account_id', sub),
                supabase.from('crm_forms').select('submissions').eq('sub_account_id', sub)
            ]);
            const opps = oppsRes.data || [], stages = stagesRes.data || [], tasks = tasksRes.data || [];
            const sum = (arr) => arr.reduce((s, o) => s + (o.value_cents || 0), 0);
            const openO = opps.filter(o => o.status === 'open'), wonO = opps.filter(o => o.status === 'won'), lostO = opps.filter(o => o.status === 'lost');
            const today = new Date(new Date().toDateString());
            const by_stage = stages.map(st => { const d = opps.filter(o => o.stage_id === st.id); return { name: st.name, is_won: st.is_won, is_lost: st.is_lost, count: d.length, value_cents: sum(d) }; });
            return res.status(200).json({
                success: true,
                report: {
                    contacts: contactsC.count || 0,
                    opps_total: opps.length,
                    open_count: openO.length, open_value_cents: sum(openO),
                    won_count: wonO.length, won_value_cents: sum(wonO),
                    lost_count: lostO.length,
                    tasks_open: tasks.filter(t => !t.done).length,
                    tasks_overdue: tasks.filter(t => !t.done && t.due_date && new Date(t.due_date) < today).length,
                    form_submissions: (formsRes.data || []).reduce((s, f) => s + (f.submissions || 0), 0),
                    by_stage
                }
            });
        }

        // ── FORMS (lead capture; public submit lives in api/crm-form.js) ─────
        if (action === 'list_forms') {
            const acc = await subAccess(personId, body.sub_account_id, 'forms');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data } = await supabase.from('crm_forms').select('*').eq('sub_account_id', body.sub_account_id).order('created_at', { ascending: false });
            return res.status(200).json({ success: true, forms: data || [] });
        }
        if (action === 'create_form') {
            const acc = await subAccess(personId, body.sub_account_id, 'forms');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const f = body.form || {};
            const name = (f.name || '').trim();
            if (!name) return res.status(400).json({ success: false, message: 'Form name required.' });
            const row = { sub_account_id: body.sub_account_id, portal_id: acc.portal_id, name, fields: Array.isArray(f.fields) ? f.fields : [], submit_message: f.submit_message || undefined, redirect_url: f.redirect_url || null, created_by: personId };
            const { data, error } = await supabase.from('crm_forms').insert(row).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not create form.' });
            return res.status(200).json({ success: true, form: data });
        }
        if (action === 'update_form') {
            const { data: form } = await supabase.from('crm_forms').select('*').eq('id', body.id).maybeSingle();
            if (!form) return res.status(404).json({ success: false, message: 'Form not found.' });
            const acc = await subAccess(personId, form.sub_account_id, 'forms');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const f = body.form || {};
            const patch = {};
            if ('name' in f && (f.name || '').trim()) patch.name = f.name.trim();
            if ('fields' in f) patch.fields = Array.isArray(f.fields) ? f.fields : [];
            if ('submit_message' in f) patch.submit_message = f.submit_message || null;
            if ('redirect_url' in f) patch.redirect_url = f.redirect_url || null;
            const { data, error } = await supabase.from('crm_forms').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update form.' });
            return res.status(200).json({ success: true, form: data });
        }
        if (action === 'delete_form') {
            const { data: form } = await supabase.from('crm_forms').select('sub_account_id').eq('id', body.id).maybeSingle();
            if (!form) return res.status(404).json({ success: false, message: 'Form not found.' });
            const acc = await subAccess(personId, form.sub_account_id, 'forms');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_forms').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        // ── TEAM / VISIBILITY ────────────────────────────────────────────────
        // People who can access this CRM (for the "Assigned to" picker).
        if (action === 'crm_members') {
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data: mems } = await supabase.from('partner_portal_members').select('*').eq('portal_id', acc.portal_id);
            const eligible = (mems || []).filter(m => m.role === 'owner' || m.role === 'agency_admin' || (m.role === 'crm_admin' && m.scope && Array.isArray(m.scope.sub_account_ids) && m.scope.sub_account_ids.includes(body.sub_account_id)));
            const pids = eligible.map(m => m.person_id);
            let people = {};
            if (pids.length) { const { data } = await supabase.from('persons').select('id, full_name, email').in('id', pids); (data || []).forEach(p => people[p.id] = p); }
            return res.status(200).json({ success: true, members: eligible.map(m => ({ person_id: m.person_id, role: m.role, full_name: (people[m.person_id] || {}).full_name || null, email: (people[m.person_id] || {}).email || null })) });
        }
        // Owner/admin-only: per-CRM visibility setting.
        if (action === 'set_crm_setting') {
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            if (!['owner', 'agency_admin', 'god'].includes(acc.role)) return res.status(403).json({ success: false, message: 'Only owners and agency admins can change this.' });
            const patch = {};
            if ('restrict_to_assigned' in body) patch.restrict_to_assigned = !!body.restrict_to_assigned;
            if ('email_mode' in body && ['individual', 'shared', 'both'].includes(body.email_mode)) patch.email_mode = body.email_mode;
            if ('ui_style' in body && ['default', 'highlevel', 'zoho', 'hubspot', 'salesforce'].includes(body.ui_style)) patch.ui_style = body.ui_style;
            if (Object.keys(patch).length) await supabase.from('agency_sub_accounts').update(patch).eq('id', body.sub_account_id);
            return res.status(200).json({ success: true });
        }

        // ── MAILBOXES (hybrid: shared CRM inbox + each person's personal) ────
        // Whether the acting person may manage this CRM's shared mailbox / settings.
        function canManageCrm(acc) { return ['owner', 'agency_admin', 'god'].includes(acc.role); }

        if (action === 'list_mailboxes') {
            const acc = await subAccess(personId, body.sub_account_id, 'conversations');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data: shared } = await supabase.from('crm_mailboxes').select('id, provider, email, label, status, connected_by, created_at').eq('sub_account_id', body.sub_account_id).order('created_at');
            const conn = await emailConn(personId);
            return res.status(200).json({ success: true, shared: shared || [], personal: conn || null, email_mode: (acc.sub && acc.sub.email_mode) || 'both', can_manage: canManageCrm(acc) });
        }
        // OAuth URL to connect a SHARED mailbox (owner/admin only). Signs scope into state.
        if (action === 'oauth_url_shared') {
            const acc = await subAccess(personId, body.sub_account_id, 'conversations');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            if (!canManageCrm(acc)) return res.status(403).json({ success: false, message: 'Only owners and agency admins can connect a shared mailbox.' });
            const provider = body.provider;
            const PORTAL_URL = process.env.SITE_URL || 'https://portal.mypayprotec.com';
            const REDIRECT_URI = `${PORTAL_URL}/api/partner-oauth`;
            const { createHmac } = await import('crypto');
            const STATE_SECRET = process.env.TOKEN_ENCRYPTION_KEY || 'fallback-secret';
            const payload = { personId, provider, scope: 'shared', sub_account_id: body.sub_account_id, ts: Date.now(), ret: (typeof body.return_to === 'string' ? body.return_to.slice(0, 300) : null) };
            const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
            const sig = createHmac('sha256', STATE_SECRET).update(b64).digest('hex').slice(0, 16);
            const state = `${b64}.${sig}`;
            let url;
            if (provider === 'google') {
                if (!process.env.GOOGLE_CLIENT_ID) return res.status(200).json({ success: false, message: 'Google OAuth not configured yet.' });
                url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly openid email', access_type: 'offline', prompt: 'consent', state });
            } else if (provider === 'microsoft') {
                if (!process.env.MICROSOFT_CLIENT_ID) return res.status(200).json({ success: false, message: 'Microsoft OAuth not configured yet.' });
                const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
                url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?` + new URLSearchParams({ client_id: process.env.MICROSOFT_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access', prompt: 'select_account', state });
            } else return res.status(400).json({ success: false, message: 'Unknown provider.' });
            return res.status(200).json({ success: true, url });
        }
        if (action === 'disconnect_shared_mailbox') {
            const acc = await subAccess(personId, body.sub_account_id, 'conversations');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            if (!canManageCrm(acc)) return res.status(403).json({ success: false, message: 'Only owners and agency admins can manage the shared mailbox.' });
            await supabase.from('crm_mailboxes').delete().eq('id', body.mailbox_id).eq('sub_account_id', body.sub_account_id);
            return res.status(200).json({ success: true });
        }

        // ── EMAIL CHANNEL (unified crm_emails store; synced from all accessible mailboxes) ──
        if (action === 'contact_emails') {
            const ca = await contactAccess(body.id, 'conversations');
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const addr = ca.contact.email;
            if (!addr) return res.status(200).json({ success: true, emails: [], no_email: true });
            const boxes = await accessibleMailboxes(personId, ca.contact.sub_account_id);
            if (!boxes.length) return res.status(200).json({ success: true, emails: [], needs_connect: true });
            let reauth = false;
            await Promise.all(boxes.map(async mb => { const r = await syncMailboxForContact(mb, addr, ca.contact.sub_account_id, ca.portal_id, body.id); if (r.reauth && mb.kind === 'personal') reauth = true; }));
            const { data: emails } = await supabase.from('crm_emails').select('*').eq('contact_id', body.id).order('sent_at', { ascending: false }).limit(100);
            return res.status(200).json({ success: true, emails: emails || [], mailboxes: boxes.map(b => ({ kind: b.kind, email: b.email, provider: b.provider, id: b.shared_mailbox_id })), needs_reauth: reauth });
        }
        // Recent email threads across this CRM (for the Conversations "Email" channel list).
        if (action === 'list_email_conversations') {
            const acc = await subAccess(personId, body.sub_account_id, 'conversations');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data: rows } = await supabase.from('crm_emails').select('*').eq('sub_account_id', body.sub_account_id).order('sent_at', { ascending: false }).limit(400);
            const own = assignedFilter(acc);
            const byContact = {};
            (rows || []).forEach(e => { if (!e.contact_id) return; if (!byContact[e.contact_id]) byContact[e.contact_id] = e; });
            let cids = Object.keys(byContact);
            const contacts = {};
            if (cids.length) { const { data: cs } = await supabase.from('crm_contacts').select('id, first_name, last_name, email, phone, company, owner_person_id').in('id', cids); (cs || []).forEach(c => contacts[c.id] = c); }
            let threads = cids.map(cid => ({ contact_id: cid, contact: contacts[cid] || null, last: byContact[cid] })).filter(t => t.contact);
            if (own) threads = threads.filter(t => t.contact.owner_person_id === own);
            threads.sort((a, b) => new Date(b.last.sent_at || 0) - new Date(a.last.sent_at || 0));
            return res.status(200).json({ success: true, threads });
        }

        if (action === 'email_body') {
            let row = null;
            if (body.email_id) { const { data } = await supabase.from('crm_emails').select('*').eq('id', body.email_id).maybeSingle(); row = data; }
            const cid = (row && row.contact_id) || body.contact_id;
            const ca = await contactAccess(cid, 'conversations');
            if (!ca) return res.status(403).json({ success: false, message: 'No access.' });
            let mb, pmid;
            if (row) {
                mb = row.shared_mailbox_id
                    ? { kind: 'shared', shared_mailbox_id: row.shared_mailbox_id, provider: row.provider }
                    : { kind: 'personal', person_id: row.mailbox_person_id || personId, provider: row.provider };
                pmid = row.provider_message_id;
            } else {
                const conn = await emailConn(personId);
                mb = conn ? { kind: 'personal', person_id: personId, provider: conn.provider } : null;
                pmid = body.message_id;
            }
            if (!mb) return res.status(400).json({ success: false, message: 'Email not connected.' });
            const at = await mailboxToken(mb);
            if (!at) return res.status(400).json({ success: false, message: 'Email not connected.' });
            try {
                if (mb.provider === 'google') {
                    const mr = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${pmid}?format=full`, { headers: { Authorization: 'Bearer ' + at } });
                    const m = await mr.json();
                    const parts = extractGmailBody(m.payload);
                    return res.status(200).json({ success: true, html: parts.html, text: parts.text });
                } else {
                    const mr = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${pmid}?$select=body`, { headers: { Authorization: 'Bearer ' + at } });
                    const m = await mr.json();
                    const isHtml = m.body && m.body.contentType === 'html';
                    return res.status(200).json({ success: true, html: isHtml ? m.body.content : '', text: isHtml ? '' : (m.body && m.body.content) || '' });
                }
            } catch (e) { return res.status(500).json({ success: false, message: 'Could not load message.' }); }
        }

        if (action === 'send_email') {
            const ca = await contactAccess(body.contact_id, 'conversations');
            if (!ca) return res.status(403).json({ success: false, message: 'No access.' });
            // Choose the sending mailbox: 'personal' or 'shared:<id>'. Default: personal, else first shared.
            const boxes = await accessibleMailboxes(personId, ca.contact.sub_account_id);
            let mb = null;
            if (body.from_mailbox === 'personal') mb = boxes.find(b => b.kind === 'personal');
            else if (typeof body.from_mailbox === 'string' && body.from_mailbox.indexOf('shared:') === 0) { const id = body.from_mailbox.slice(7); mb = boxes.find(b => b.kind === 'shared' && b.shared_mailbox_id === id); }
            if (!mb) mb = boxes.find(b => b.kind === 'personal') || boxes.find(b => b.kind === 'shared');
            if (!mb) return res.status(400).json({ success: false, message: 'Connect a mailbox first.' });
            const at = await mailboxToken(mb);
            if (!at) return res.status(400).json({ success: false, message: 'That mailbox needs reconnecting.' });
            const to = (body.to || ca.contact.email || '').trim();
            const subject = (body.subject || '').trim() || '(no subject)';
            const html = (body.body || '').replace(/\n/g, '<br>');
            if (!to) return res.status(400).json({ success: false, message: 'No recipient email.' });
            const ccList = (Array.isArray(body.cc) ? body.cc : String(body.cc || '').split(/[,;]/))
                .map(x => String(x).trim()).filter(Boolean)
                .filter((x, i, a) => a.indexOf(x) === i && x.toLowerCase() !== to.toLowerCase());
            const cc = ccList.join(', ');
            try {
                let sentId = null, sentThread = body.thread_id || null;
                if (mb.provider === 'google') {
                    var mime = ['To: ' + to, 'From: ' + mb.email];
                    if (cc) mime.push('Cc: ' + cc);
                    mime.push('Subject: ' + subject, 'Content-Type: text/html; charset=UTF-8', 'MIME-Version: 1.0');
                    if (body.in_reply_to) { mime.push('In-Reply-To: ' + body.in_reply_to); mime.push('References: ' + body.in_reply_to); }
                    mime = mime.join('\r\n') + '\r\n\r\n' + html;
                    const payload = { raw: b64urlEncode(mime) };
                    if (body.thread_id) payload.threadId = body.thread_id;
                    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    if (!r.ok) return res.status(500).json({ success: false, message: 'Gmail send failed.' });
                    const sent = await r.json(); sentId = sent && sent.id; sentThread = (sent && sent.threadId) || sentThread;
                } else {
                    const msg = { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] };
                    if (ccList.length) msg.ccRecipients = ccList.map(a => ({ emailAddress: { address: a } }));
                    const r = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
                    if (r.status !== 202) return res.status(500).json({ success: false, message: 'Outlook send failed.' });
                }
                // Record the outbound message in the email store so it shows instantly + attributed.
                // (Gmail returns an id; Graph doesn't — that one is picked up on the next sync.)
                if (sentId) {
                    await supabase.from('crm_emails').upsert({
                        sub_account_id: ca.contact.sub_account_id, portal_id: ca.portal_id, contact_id: body.contact_id,
                        mailbox_kind: mb.kind, mailbox_email: mb.email, mailbox_person_id: mb.person_id, shared_mailbox_id: mb.shared_mailbox_id,
                        provider: mb.provider, provider_message_id: sentId, provider_thread_id: sentThread, rfc_message_id: body.in_reply_to || '',
                        direction: 'outbound', from_address: mb.email, from_name: '', to_addresses: to, cc_addresses: cc,
                        subject, snippet: (body.body || '').slice(0, 200), sent_at: new Date().toISOString(), unread: false
                    }, { onConflict: 'sub_account_id,mailbox_email,provider_message_id' });
                }
                return res.status(200).json({ success: true });
            } catch (e) { return res.status(500).json({ success: false, message: 'Could not send email.' }); }
        }

        // ── AUTOMATION (workflows) ───────────────────────────────────────────
        if (action === 'list_workflows') {
            const acc = await subAccess(personId, body.sub_account_id, 'automation');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data } = await supabase.from('crm_workflows').select('*').eq('sub_account_id', body.sub_account_id).order('created_at', { ascending: false });
            return res.status(200).json({ success: true, workflows: data || [], triggers: WORKFLOW_TRIGGERS, action_types: WORKFLOW_ACTIONS });
        }
        if (action === 'create_workflow' || action === 'update_workflow') {
            let subId2;
            if (action === 'update_workflow') { const { data: w } = await supabase.from('crm_workflows').select('sub_account_id').eq('id', body.id).maybeSingle(); if (!w) return res.status(404).json({ success: false, message: 'Not found.' }); subId2 = w.sub_account_id; }
            else subId2 = body.sub_account_id;
            const acc = await subAccess(personId, subId2, 'automation');
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const w = body.workflow || {};
            const patch = {};
            if ('name' in w) { const nm = (w.name || '').trim(); if (!nm) return res.status(400).json({ success: false, message: 'Name required.' }); patch.name = nm; }
            if ('enabled' in w) patch.enabled = !!w.enabled;
            if ('trigger' in w) patch.trigger = WORKFLOW_TRIGGERS.includes(w.trigger) ? w.trigger : 'contact_created';
            if ('trigger_config' in w && w.trigger_config && typeof w.trigger_config === 'object') patch.trigger_config = w.trigger_config;
            if ('actions' in w && Array.isArray(w.actions)) patch.actions = w.actions.filter(a => a && WORKFLOW_ACTIONS.includes(a.type)).map(a => ({ type: a.type, config: a.config || {} }));
            if (action === 'create_workflow') {
                const row = Object.assign({ sub_account_id: subId2, portal_id: acc.portal_id, created_by: personId, trigger: 'contact_created', trigger_config: {}, actions: [] }, patch);
                if (!row.name) return res.status(400).json({ success: false, message: 'Name required.' });
                const { data, error } = await supabase.from('crm_workflows').insert(row).select('*').single();
                if (error) return res.status(500).json({ success: false, message: 'Could not create workflow.' });
                return res.status(200).json({ success: true, workflow: data });
            } else {
                patch.updated_at = new Date().toISOString();
                const { data, error } = await supabase.from('crm_workflows').update(patch).eq('id', body.id).select('*').single();
                if (error) return res.status(500).json({ success: false, message: 'Could not update workflow.' });
                return res.status(200).json({ success: true, workflow: data });
            }
        }
        if (action === 'delete_workflow') {
            const { data: w } = await supabase.from('crm_workflows').select('sub_account_id').eq('id', body.id).maybeSingle();
            if (!w) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, w.sub_account_id, 'automation');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_workflows').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }
        if (action === 'list_workflow_runs') {
            const { data: w } = await supabase.from('crm_workflows').select('sub_account_id').eq('id', body.workflow_id).maybeSingle();
            if (!w) return res.status(404).json({ success: false, message: 'Not found.' });
            const acc = await subAccess(personId, w.sub_account_id, 'automation');
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const { data } = await supabase.from('crm_workflow_runs').select('*').eq('workflow_id', body.workflow_id).order('created_at', { ascending: false }).limit(50);
            return res.status(200).json({ success: true, runs: data || [] });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }

    // Replace a contact's tags with the given set (only tags in the same CRM count).
    async function applyTags(contactId, subId, tagIds) {
        let valid = [];
        const ids = Array.isArray(tagIds) ? tagIds : [];
        if (ids.length) {
            const { data: tags } = await supabase.from('crm_tags').select('id').eq('sub_account_id', subId).in('id', ids);
            valid = (tags || []).map(t => t.id);
        }
        await supabase.from('crm_contact_tags').delete().eq('contact_id', contactId);
        if (valid.length) await supabase.from('crm_contact_tags').insert(valid.map(tid => ({ contact_id: contactId, tag_id: tid })));
        return valid;
    }
}
