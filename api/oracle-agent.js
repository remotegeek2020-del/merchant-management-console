import { GoogleGenerativeAI } from "@google/generative-ai";
import { validateSession, sessionErrorResponse } from './_validate.js';
import { createClient } from '@supabase/supabase-js';
import { loadActor, isAdminRole, canDeleteLeads } from './_access.js';
import { issueCertificate } from './certificates.js';
import { notifyPartner, partnerForMerchant } from './_notify.js';
import { sendLeadInvite } from './_lead-invite.js';
import { dispatchEvent } from './v1/_deliver.js';

// ── Generic operator query support ────────────────────────────────────────────
// Allowlisted entities Jarvis can query. Read-only; no raw SQL from the model.
const JARVIS_ENTITIES = {
    merchants:   { table: 'merchants',        date: 'created_at', dateAlt: ['enrollment_date', 'approved_date'], statusCol: 'account_status', prime49: 'merchant', select: 'merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_30_day, created_at' },
    partners:    { table: 'persons',          date: 'created_at', dateAlt: ['enrolled_at'],                      statusCol: null,             prime49: 'partner',  select: 'id, full_name, email, enrolled_at, is_portal_active, created_at' },
    prospects:   { table: 'leads',            date: 'created_at', dateAlt: [],                                    statusCol: 'status',         select: 'id, full_name, email, status, assigned_rep, created_at' },
    pos_leads:   { table: 'pos_leads',        date: 'created_at', dateAlt: [],                                    statusCol: 'status',         select: 'id, status, classification, partner_id, created_at' },
    deployments: { table: 'deployments',      date: 'created_at', dateAlt: ['target_deployment_date'],           statusCol: 'status',         select: 'id, status, merchant_id, target_deployment_date, created_at' },
    returns:     { table: 'returns',          date: 'created_at', dateAlt: [],                                    statusCol: 'status',         select: 'return_id, status, return_reason, merchant_id, created_at' },
    tickets:     { table: 'support_tickets',  date: 'created_at', dateAlt: [],                                    statusCol: 'status',         select: 'ticket_number, subject, status, priority, created_at' }
};

// Turn a relative keyword (or ISO date) into {gte, lt} ISO bounds.
function jarvisDateRange(since, until) {
    const now = new Date();
    const iso = (d) => d.toISOString();
    const startOfDay = (d) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };
    const daysAgo = (n) => { const x = new Date(now); x.setUTCDate(x.getUTCDate() - n); return x; };
    let gte = null, lt = null;
    const key = String(since || '').toLowerCase().trim();
    switch (key) {
        case 'today': gte = startOfDay(now); break;
        case 'yesterday': gte = startOfDay(daysAgo(1)); lt = startOfDay(now); break;
        case 'last_7_days': case 'last_week': case 'past_week': gte = daysAgo(7); break;
        case 'this_week': { const dow = (startOfDay(now).getUTCDay() + 6) % 7; gte = startOfDay(daysAgo(dow)); break; }
        case 'last_14_days': case 'last_2_weeks': gte = daysAgo(14); break;
        case 'last_30_days': case 'past_month': gte = daysAgo(30); break;
        case 'this_month': gte = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); break;
        case 'last_month': gte = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)); lt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); break;
        case 'last_90_days': case 'last_quarter': gte = daysAgo(90); break;
        case 'this_year': case 'ytd': gte = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)); break;
        default: if (/^\d{4}-\d{2}-\d{2}/.test(key)) gte = new Date(key);
    }
    if (until && /^\d{4}-\d{2}-\d{2}/.test(String(until))) lt = new Date(until);
    return { gte: gte ? iso(gte) : null, lt: lt ? iso(lt) : null };
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ answer: "Method not allowed." });

    const { query, userId, userName, lastResponse } = req.body;
    if (!query && !req.body.mode && !(req.body.execute_action && req.body.execute_action.name)) return res.status(400).json({ answer: "No query provided." });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ answer: "GEMINI_API_KEY is not configured." });
    }

    // ── OPERATOR MODE (writes) ────────────────────────────────────────────────
    // Jarvis can PREPARE actions; the user must confirm in the UI before they run.
    // Gated by the app_settings flag `jarvis_operator_enabled` and per-action access.
    const actor = await loadActor(session.userid);
    let opEnabled = false;
    try {
        const { data: fl } = await supabase.from('app_settings').select('value').eq('key', 'jarvis_operator_enabled').maybeSingle();
        opEnabled = String(fl?.value) === 'true';
    } catch (e) { opEnabled = false; }

    // Access gate: only super_admins or users with the Jarvis permission.
    const jarvisAllowed = !!actor && actor.is_active !== false && (String(actor.role || '') === 'super_admin' || actor.access_jarvis === true);
    if (!jarvisAllowed) {
        return res.status(200).json({ answer: 'You do not have access to Jarvis. Ask a super admin to enable it for your account.', suggestions: [], tools_used: [], denied: true });
    }

    // ── Conversation (thread) management — ChatGPT-style ──────────────────────
    if (req.body.mode === 'list_conversations') {
        const { data } = await supabase.from('jarvis_conversations').select('id, title, updated_at').eq('userid', userId).order('updated_at', { ascending: false }).limit(100);
        return res.status(200).json({ conversations: data || [] });
    }
    if (req.body.mode === 'rename_conversation') {
        if (!req.body.conversation_id) return res.status(400).json({ success: false });
        await supabase.from('jarvis_conversations').update({ title: String(req.body.title || 'Conversation').slice(0, 120) }).eq('id', req.body.conversation_id).eq('userid', userId);
        return res.status(200).json({ success: true });
    }
    if (req.body.mode === 'delete_conversation') {
        if (!req.body.conversation_id) return res.status(400).json({ success: false });
        await supabase.from('chat_history').delete().eq('conversation_id', req.body.conversation_id);
        await supabase.from('jarvis_conversations').delete().eq('id', req.body.conversation_id).eq('userid', userId);
        return res.status(200).json({ success: true });
    }

    // History mode: return one conversation's messages (or the latest thread).
    if (req.body.mode === 'history') {
        let convId = req.body.conversation_id || null;
        if (!convId) {
            const { data: last } = await supabase.from('jarvis_conversations').select('id').eq('userid', userId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
            convId = last ? last.id : null;
        }
        if (!convId) return res.status(200).json({ history: [], conversation_id: null });
        const { data } = await supabase.from('chat_history').select('role, content').eq('conversation_id', convId).order('id', { ascending: false }).limit(60);
        return res.status(200).json({ history: (data || []).reverse(), conversation_id: convId });
    }

    let pendingAction = null; // set by an action tool during the agentic loop

    const ACTION_SPECS = {
        assign_prospect_rep: {
            access: (a) => !!a && a.is_active !== false && (isAdminRole(a) || a.access_prospects === true || a.access_lead_portal === true),
            describe: async (args) => {
                let rep = args.rep_userid, lead = args.lead_id;
                try { const { data: u } = await supabase.from('app_users').select('first_name,last_name,email').eq('userid', args.rep_userid).maybeSingle(); if (u) rep = (`${u.first_name || ''} ${u.last_name || ''}`.trim()) || u.email; } catch (e) {}
                try { const { data: l } = await supabase.from('leads').select('full_name,email').eq('id', args.lead_id).maybeSingle(); if (l) lead = l.full_name || l.email; } catch (e) {}
                return `Assign rep ${rep} to prospect ${lead}`;
            },
            run: async (args) => {
                if (!args.lead_id || !args.rep_userid) return { ok: false, message: 'lead_id and rep_userid are required.' };
                const { error } = await supabase.from('leads').update({ assigned_rep: args.rep_userid }).eq('id', args.lead_id);
                return error ? { ok: false, message: error.message } : { ok: true, message: 'Rep assigned to the prospect.' };
            }
        },
        award_certificate: {
            access: (a) => !!a && a.is_active !== false && String(a.role || '') === 'super_admin',
            describe: async (args) => {
                let who = args.person_id;
                try { const { data: p } = await supabase.from('persons').select('full_name').eq('id', args.person_id).maybeSingle(); if (p) who = p.full_name; } catch (e) {}
                return `Award certificate "${args.type_id}" to ${who}`;
            },
            run: async (args) => {
                if (!args.person_id || !args.type_id) return { ok: false, message: 'person_id and type_id are required.' };
                const r = await issueCertificate(supabase, { personId: args.person_id, typeId: args.type_id, source: 'awarded' });
                if (!r.ok) return { ok: false, message: r.error || 'Could not award certificate.' };
                return { ok: true, message: r.created ? 'Certificate awarded.' : 'Partner already held that certificate.' };
            }
        },
        update_ticket_status: {
            access: (a) => !!a && a.is_active !== false,
            describe: async (args) => {
                let tn = args.ticket_id;
                try { const { data: t } = await supabase.from('support_tickets').select('ticket_number').eq('id', args.ticket_id).maybeSingle(); if (t) tn = t.ticket_number; } catch (e) {}
                return `Set ticket ${tn} status to "${args.status}"`;
            },
            run: async (args) => {
                const VALID = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];
                if (!args.ticket_id || !args.status) return { ok: false, message: 'ticket_id and status are required.' };
                const status = String(args.status).toLowerCase().replace(/\s+/g, '_');
                if (VALID.indexOf(status) < 0) return { ok: false, message: 'Invalid status. Use one of: ' + VALID.join(', ') };
                const { data: t } = await supabase.from('support_tickets').select('person_id, ticket_number, subject').eq('id', args.ticket_id).maybeSingle();
                if (!t) return { ok: false, message: 'Ticket not found.' };
                const { error } = await supabase.from('support_tickets').update({ status, updated_at: new Date().toISOString() }).eq('id', args.ticket_id);
                if (error) return { ok: false, message: error.message };
                if (t.person_id) {
                    try { await supabase.rpc('increment_partner_unread', { tid: parseInt(args.ticket_id) }); } catch (e) {}
                    await notifyPartner(supabase, { personId: t.person_id, type: 'ticket_update', title: `Ticket ${t.ticket_number} — ${status.replace(/_/g, ' ')}`, body: t.subject || '', link: '/partner/tickets', actorName: 'PayProTec Staff' });
                }
                return { ok: true, message: `Ticket ${t.ticket_number} set to ${status.replace(/_/g, ' ')}.` };
            }
        },
        add_partner_note: {
            access: (a) => !!a && a.is_active !== false,
            describe: async (args) => {
                let who = args.person_id;
                try { const { data: p } = await supabase.from('persons').select('full_name').eq('id', args.person_id).maybeSingle(); if (p) who = p.full_name; } catch (e) {}
                return `Add a note to partner ${who}: "${String(args.body || '').slice(0, 80)}"`;
            },
            run: async (args) => {
                if (!args.person_id || !args.body) return { ok: false, message: 'person_id and body are required.' };
                const { error } = await supabase.from('partner_notes').insert({ person_id: args.person_id, title: String(args.title || 'Note').slice(0, 160), body: String(args.body), note_type: 'general', author_name: actorLabel, source: 'jarvis' });
                return error ? { ok: false, message: error.message } : { ok: true, message: 'Note added to the partner.' };
            }
        },
        add_merchant_note: {
            access: (a) => !!a && a.is_active !== false,
            describe: async (args) => {
                let who = args.merchant_id;
                try { const { data: m } = await supabase.from('merchants').select('dba_name').eq('id', args.merchant_id).maybeSingle(); if (m) who = m.dba_name; } catch (e) {}
                return `Add a note to merchant ${who}: "${String(args.body || '').slice(0, 80)}"`;
            },
            run: async (args) => {
                if (!args.merchant_id || !args.body) return { ok: false, message: 'merchant_id (uuid) and body are required.' };
                const { error } = await supabase.from('merchant_notes').insert({ merchant_id: args.merchant_id, title: String(args.title || 'Note').slice(0, 160), body: String(args.body), created_by: actorLabel });
                return error ? { ok: false, message: error.message } : { ok: true, message: 'Note added to the merchant.' };
            }
        },
        create_task: {
            access: (a) => !!a && a.is_active !== false,
            describe: async (args) => {
                let m = args.merchant_id, who = args.assigned_to || 'unassigned';
                try { const { data: mm } = await supabase.from('merchants').select('dba_name').eq('id', args.merchant_id).maybeSingle(); if (mm) m = mm.dba_name; } catch (e) {}
                if (args.assigned_to) { try { const { data: u } = await supabase.from('app_users').select('first_name,last_name').eq('userid', args.assigned_to).maybeSingle(); if (u) who = (`${u.first_name || ''} ${u.last_name || ''}`.trim()); } catch (e) {} }
                return `Create task "${String(args.title || '').slice(0, 60)}" on ${m}${args.assigned_to ? ' — assigned to ' + who : ''}${args.due_date ? ', due ' + args.due_date : ''}`;
            },
            run: async (args) => {
                if (!args.title || !args.merchant_id) return { ok: false, message: 'title and merchant_id (uuid) are required.' };
                const row = { merchant_id: args.merchant_id, title: String(args.title).slice(0, 200), body: String(args.body || ''), status: 'open', created_by: actorLabel, priority: ['low', 'medium', 'high'].indexOf(String(args.priority || '').toLowerCase()) >= 0 ? String(args.priority).toLowerCase() : 'medium', source: 'jarvis' };
                if (args.assigned_to) row.assigned_to = args.assigned_to;
                if (args.due_date && /^\d{4}-\d{2}-\d{2}/.test(String(args.due_date))) row.due_date = args.due_date;
                const { data: t, error } = await supabase.from('merchant_tasks').insert(row).select('id').single();
                if (error) return { ok: false, message: error.message };
                if (args.assigned_to) {
                    let dba = ''; try { const { data: mm } = await supabase.from('merchants').select('dba_name').eq('id', args.merchant_id).maybeSingle(); dba = (mm && mm.dba_name) || ''; } catch (e) {}
                    try { await supabase.from('user_notifications').insert({ user_id: args.assigned_to, type: 'task_assigned', title: 'New task: ' + row.title, body: dba ? 'On ' + dba : '', merchant_id: args.merchant_id, merchant_name: dba, task_id: t.id, from_name: actorLabel, is_read: false }); } catch (e) {}
                }
                return { ok: true, message: 'Task created' + (args.assigned_to ? ' and assigned.' : '.') };
            }
        },
        add_ticket_comment: {
            access: (a) => !!a && a.is_active !== false,
            describe: async (args) => {
                let tn = args.ticket_id;
                try { const { data: t } = await supabase.from('support_tickets').select('ticket_number').eq('id', args.ticket_id).maybeSingle(); if (t) tn = t.ticket_number; } catch (e) {}
                return `${args.is_internal ? 'Internal note' : 'Reply'} on ticket ${tn}: "${String(args.body || '').slice(0, 80)}"` + (args.is_internal ? '' : ' (the partner will be notified)');
            },
            run: async (args) => {
                if (!args.ticket_id || !args.body) return { ok: false, message: 'ticket_id and body are required.' };
                const isInternal = !!args.is_internal;
                const { data: t } = await supabase.from('support_tickets').select('person_id, ticket_number, subject').eq('id', args.ticket_id).maybeSingle();
                if (!t) return { ok: false, message: 'Ticket not found.' };
                const { error } = await supabase.from('ticket_comments').insert({ ticket_id: args.ticket_id, author_type: 'staff', author_name: actorLabel, body: String(args.body), is_internal: isInternal });
                if (error) return { ok: false, message: error.message };
                await supabase.from('support_tickets').update({ updated_at: new Date().toISOString() }).eq('id', args.ticket_id);
                if (!isInternal && t.person_id) {
                    try { await supabase.rpc('increment_partner_unread', { tid: parseInt(args.ticket_id) }); } catch (e) {}
                    await notifyPartner(supabase, { personId: t.person_id, type: 'ticket_reply', title: `New reply on ticket ${t.ticket_number}`, body: String(args.body).slice(0, 140), link: '/partner/tickets', actorName: actorLabel });
                }
                return { ok: true, message: `Comment added to ticket ${t.ticket_number}.` };
            }
        },
        send_prospect_invite: {
            access: (a) => !!a && a.is_active !== false && (isAdminRole(a) || a.access_prospects === true || a.access_lead_portal === true),
            describe: async (args) => {
                let who = args.lead_id;
                try { const { data: l } = await supabase.from('leads').select('full_name,email').eq('id', args.lead_id).maybeSingle(); if (l) who = (l.full_name || '') + ' <' + (l.email || '') + '>'; } catch (e) {}
                return `Email a portal setup invite to prospect ${who}`;
            },
            run: async (args) => {
                if (!args.lead_id) return { ok: false, message: 'lead_id is required.' };
                const { data: lead } = await supabase.from('leads').select('id, full_name, email, password_hash').eq('id', args.lead_id).maybeSingle();
                if (!lead) return { ok: false, message: 'Prospect not found.' };
                if (lead.password_hash) return { ok: false, message: 'This prospect already has an active account — invite not sent.' };
                if (!lead.email) return { ok: false, message: 'Prospect has no email.' };
                const okSent = await sendLeadInvite(supabase, { id: lead.id, full_name: lead.full_name, email: lead.email }, reqHost);
                return okSent ? { ok: true, message: 'Invite emailed to ' + lead.email + '.' } : { ok: false, message: 'Could not send the invite email.' };
            }
        },
        notify_partner: {
            access: (a) => !!a && a.is_active !== false,
            describe: async (args) => {
                let who = args.person_id;
                try { const { data: p } = await supabase.from('persons').select('full_name').eq('id', args.person_id).maybeSingle(); if (p) who = p.full_name; } catch (e) {}
                return `Send a portal notification to ${who}: "${String(args.title || args.body || '').slice(0, 80)}"`;
            },
            run: async (args) => {
                if (!args.person_id || !(args.title || args.body)) return { ok: false, message: 'person_id and a title/body are required.' };
                await notifyPartner(supabase, { personId: args.person_id, type: 'message', title: String(args.title || 'Message from PayProTec').slice(0, 160), body: String(args.body || '').slice(0, 400), link: args.link || '/partner/dashboard', actorName: actorLabel });
                return { ok: true, message: 'Notification sent to the partner.' };
            }
        },

        // ── DESTRUCTIVE actions (require typed CONFIRM) ───────────────────────
        update_merchant_status: {
            dangerous: true,
            access: (a) => !!a && a.is_active !== false && String(a.role || '') === 'super_admin',
            describe: async (args) => {
                let who = args.merchant_id;
                try { const { data: m } = await supabase.from('merchants').select('dba_name, account_status').eq('id', args.merchant_id).maybeSingle(); if (m) who = `${m.dba_name} (currently ${m.account_status || '—'})`; } catch (e) {}
                return `Change status of merchant ${who} → "${args.status}". This fires the merchant.status_changed webhook.`;
            },
            run: async (args) => {
                if (!args.merchant_id || !args.status) return { ok: false, message: 'merchant_id (uuid) and status are required.' };
                const VALID = ['Approved', 'Suspended', 'Terminated', 'Pending', 'PCI Non-Compliant', 'Approved - Collections'];
                const match = VALID.find(v => v.toLowerCase() === String(args.status).toLowerCase()) || String(args.status);
                const { data: m } = await supabase.from('merchants').select('id, dba_name, merchant_id, account_status, agent_id').eq('id', args.merchant_id).maybeSingle();
                if (!m) return { ok: false, message: 'Merchant not found.' };
                const old = m.account_status;
                const { error } = await supabase.from('merchants').update({ account_status: match }).eq('id', args.merchant_id);
                if (error) return { ok: false, message: error.message };
                try { await supabase.from('merchant_notes').insert({ merchant_id: args.merchant_id, title: 'Status changed', body: `Status: ${old || '—'} → ${match} (via Jarvis by ${actorLabel})`, created_by: actorLabel }); } catch (e) {}
                try { const pid = await partnerForMerchant(supabase, args.merchant_id); if (pid) dispatchEvent(pid, 'merchant.status_changed', { merchant_id: m.merchant_id, dba_name: m.dba_name, old_status: old, new_status: match, changed_by: actorLabel }).catch(() => {}); } catch (e) {}
                return { ok: true, message: `${m.dba_name} status set to ${match}.` };
            }
        },
        delete_prospect: {
            dangerous: true,
            access: (a) => canDeleteLeads(a),
            describe: async (args) => {
                let who = args.lead_id;
                try { const { data: l } = await supabase.from('leads').select('full_name, email').eq('id', args.lead_id).maybeSingle(); if (l) who = (l.full_name || '') + ' <' + (l.email || '') + '>'; } catch (e) {}
                return `Permanently delete prospect ${who} and revoke their portal access. This cannot be undone.`;
            },
            run: async (args) => {
                if (!args.lead_id) return { ok: false, message: 'lead_id is required.' };
                try { await supabase.from('lead_sessions').delete().eq('lead_id', args.lead_id); } catch (e) {}
                try { await supabase.from('lead_onboarding_answers').delete().eq('lead_id', args.lead_id); } catch (e) {}
                try { await supabase.from('course_video_views').delete().eq('lead_id', args.lead_id); } catch (e) {}
                const { error } = await supabase.from('leads').delete().eq('id', args.lead_id);
                return error ? { ok: false, message: error.message } : { ok: true, message: 'Prospect deleted and portal access revoked.' };
            }
        },
        delete_task: {
            dangerous: true,
            access: (a) => isAdminRole(a),
            describe: async (args) => {
                let who = args.task_id;
                try { const { data: t } = await supabase.from('merchant_tasks').select('title').eq('id', args.task_id).maybeSingle(); if (t) who = '"' + t.title + '"'; } catch (e) {}
                return `Delete task ${who}. This cannot be undone.`;
            },
            run: async (args) => {
                if (!args.task_id) return { ok: false, message: 'task_id is required.' };
                try { await supabase.from('task_comments').delete().eq('task_id', args.task_id); } catch (e) {}
                const { error } = await supabase.from('merchant_tasks').delete().eq('id', args.task_id);
                return error ? { ok: false, message: error.message } : { ok: true, message: 'Task deleted.' };
            }
        },
        delete_ticket: {
            dangerous: true,
            access: (a) => !!a && a.is_active !== false && (String(a.role || '') === 'super_admin' || a.can_delete_tickets === true),
            describe: async (args) => {
                let who = args.ticket_id;
                try { const { data: t } = await supabase.from('support_tickets').select('ticket_number, subject').eq('id', args.ticket_id).maybeSingle(); if (t) who = `#${t.ticket_number} — ${t.subject || ''}`; } catch (e) {}
                return `Delete ticket ${who}. It is archived (restorable), but removed from the queue.`;
            },
            run: async (args) => {
                if (!args.ticket_id) return { ok: false, message: 'ticket_id is required.' };
                const { data: fullT } = await supabase.from('support_tickets').select('*').eq('id', args.ticket_id).maybeSingle();
                if (!fullT) return { ok: false, message: 'Ticket not found.' };
                try {
                    const { data: cmts } = await supabase.from('ticket_comments').select('*').eq('ticket_id', args.ticket_id);
                    await supabase.from('deleted_records').insert({ entity_type: 'ticket', entity_id: String(fullT.id), label: `Ticket #${fullT.ticket_number || ''} — ${fullT.subject || ''}`, snapshot: { ...fullT, __comments: cmts || [] }, deleted_by: (actor && actor.userid) || '' });
                } catch (e) {}
                await supabase.from('ticket_comments').delete().eq('ticket_id', args.ticket_id);
                const { error } = await supabase.from('support_tickets').delete().eq('id', args.ticket_id);
                return error ? { ok: false, message: error.message } : { ok: true, message: `Ticket ${fullT.ticket_number || ''} deleted (archived — restorable from the recycle bin).` };
            }
        }
    };
    const actorLabel = (`${actor && actor.first_name || ''} ${actor && actor.last_name || ''}`.trim()) || (actor && actor.email) || 'PayProTec Staff';
    const reqHost = req.headers && req.headers.host;

    // ── EXECUTE path: the UI calls this after the user clicks Confirm ──────────
    if (req.body.execute_action && req.body.execute_action.name) {
        const { name, args } = req.body.execute_action;
        const spec = ACTION_SPECS[name];
        if (!spec) return res.status(200).json({ answer: 'Unknown action.', executed: false });
        if (!opEnabled) return res.status(200).json({ answer: 'Operator mode is off. Enable "Jarvis Operator" in Secret Dungeon → Feature Flags.', executed: false });
        if (!spec.access(actor)) return res.status(200).json({ answer: 'You do not have permission for that action.', executed: false });
        if (spec.dangerous && String(req.body.execute_action.confirm_text || '').trim().toUpperCase() !== 'CONFIRM') {
            return res.status(200).json({ answer: 'This is a destructive action — type CONFIRM to proceed.', executed: false, needs_confirm_text: true });
        }
        const r = await spec.run(args || {});
        try {
            await supabase.from('activity_logs').insert({
                email: actor?.email || session.userid, action: `Jarvis operator: ${name} — ${r.ok ? 'done' : 'failed'}`,
                status: r.ok ? 'success' : 'error', category: 'admin', target_type: 'jarvis_action', target_id: name,
                severity: r.ok ? 'info' : 'warning', new_value: { args, message: r.message }
            });
        } catch (e) {}
        return res.status(200).json({ answer: (r.ok ? '✅ ' : '⚠️ ') + r.message, executed: !!r.ok });
    }

    // ── TOOL DEFINITIONS ──────────────────────────────────────────────────────
    const functionDeclarations = [

        // ── MERCHANTS ──────────────────────────────────────────────────────────
        {
            name: 'get_merchant_overview',
            description: 'Get a high-level merchant health summary: total active, suspended, at-risk count, average monthly volume, and top performers.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_merchants',
            description: 'Search merchants by business name (DBA) or merchant ID (MID). Returns status, volume, agent.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Name or MID to search for' },
                    limit: { type: 'number', description: 'Max results, default 10' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_merchant_detail',
            description: 'Get full profile for a specific merchant by MID string: status, volume trend, agent, open returns, active deployments.',
            parameters: {
                type: 'object',
                properties: {
                    merchant_id: { type: 'string', description: 'The merchant MID string' }
                },
                required: ['merchant_id']
            }
        },
        {
            name: 'get_at_risk_merchants',
            description: 'Get merchants whose 30-day processing volume has dropped 15%+ below their 90-day monthly baseline. Sorted by largest drop first.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max results, default 20' },
                    min_drop_pct: { type: 'number', description: 'Minimum drop % to include, default 15' }
                },
                required: []
            }
        },
        {
            name: 'get_merchants_by_status',
            description: 'Get merchants filtered by account status (Approved, Suspended, Terminated, Pending, PCI Non-Compliant, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'Account status value' },
                    limit: { type: 'number', description: 'Max results, default 20' }
                },
                required: ['status']
            }
        },

        // ── PARTNERS ──────────────────────────────────────────────────────────
        {
            name: 'get_partner_overview',
            description: 'Get a summary of the partner network: total partners, how many have portal access, top partners by volume.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_partners',
            description: 'Search for partners (agents/reps) by name. Returns their merchant count, total volume, and portal status.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Partner name to search' },
                    limit: { type: 'number', description: 'Max results, default 10' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_partner_detail',
            description: 'Get detailed portfolio for a specific partner by their person_id: their merchants, volumes, at-risk merchants.',
            parameters: {
                type: 'object',
                properties: {
                    person_id: { type: 'string', description: 'The partner person UUID' }
                },
                required: ['person_id']
            }
        },
        {
            name: 'get_partners_without_portal',
            description: 'Get partners who have NOT yet been given portal access (is_portal_active is false).',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max results, default 20' }
                },
                required: []
            }
        },

        // ── DEPLOYMENTS ────────────────────────────────────────────────────────
        {
            name: 'get_deployment_overview',
            description: 'Get deployment pipeline summary: count by status (Pending, In Progress, Delivered, Cancelled), recent activity.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'get_deployments',
            description: 'Get deployments filtered by status. Status options: Pending, In Progress, Delivered, Cancelled.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'Deployment status filter, or omit for all recent' },
                    limit: { type: 'number', description: 'Max results, default 15' }
                },
                required: []
            }
        },

        // ── INVENTORY ──────────────────────────────────────────────────────────
        {
            name: 'get_inventory_overview',
            description: 'Get inventory health: total equipment count, stocked units, deployed units, units in repair, decommissioned count.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_inventory',
            description: 'Search inventory by serial number or terminal/device type.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Serial number or device type to search' },
                    limit: { type: 'number', description: 'Max results, default 15' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_inventory_by_location',
            description: 'Get equipment at a specific location. Locations: Warsaw Office, Warsaw Repairs, Merchant Site, In Transit.',
            parameters: {
                type: 'object',
                properties: {
                    location: { type: 'string', description: 'Location name' },
                    limit: { type: 'number', description: 'Max results, default 20' }
                },
                required: ['location']
            }
        },

        // ── RETURNS ────────────────────────────────────────────────────────────
        {
            name: 'get_returns_overview',
            description: 'Get returns summary: open count, pending count, defective rate, recent return activity.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'get_returns',
            description: 'Get return requests filtered by status (Open, Pending, Completed, Cancelled).',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'Return status, or omit for open/pending' },
                    limit: { type: 'number', description: 'Max results, default 15' }
                },
                required: []
            }
        },

        // ── UNIVERSAL QUERY (counts/lists with filters + date ranges) ──────────
        {
            name: 'query_records',
            description: 'Powerful universal read across core entities. Use this for "how many / which / list" questions with a time window, status, or Prime49 filter — e.g. "Prime49 merchants added last week", "partners enrolled this month", "open tickets", "POS leads today". Set count_only:true for "how many" questions.',
            parameters: {
                type: 'object',
                properties: {
                    entity: { type: 'string', description: 'One of: merchants, partners, prospects, pos_leads, deployments, returns, tickets' },
                    since: { type: 'string', description: 'Time window: today, yesterday, last_7_days (=last week), this_week, last_14_days, last_30_days, this_month, last_month, last_90_days, this_year — or an ISO date YYYY-MM-DD' },
                    until: { type: 'string', description: 'Optional ISO end date YYYY-MM-DD' },
                    date_field: { type: 'string', description: 'Which date to filter on. Default created_at. merchants also allow enrollment_date/approved_date; partners allow enrolled_at; deployments allow target_deployment_date.' },
                    status: { type: 'string', description: 'Optional status filter (e.g. Approved, open, Pending)' },
                    prime49_only: { type: 'boolean', description: 'Only Prime49 (merchants or partners)' },
                    count_only: { type: 'boolean', description: 'Return just the count (for "how many" questions)' },
                    limit: { type: 'number', description: 'Max sample rows when listing, default 15, max 50' }
                },
                required: ['entity']
            }
        },

        // ── OPERATOR: read helpers (to resolve ids before proposing an action) ──
        {
            name: 'search_prospects',
            description: 'Search prospects/leads by name or email. Returns lead id, name, email, status, and assigned rep. Use to get the lead id before assigning a rep.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'Name or email' } }, required: ['query'] }
        },
        {
            name: 'list_reps',
            description: 'List active staff users (reps) with their userid and name. Use to resolve the rep_userid before assigning a rep to a prospect.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'find_partner_person',
            description: 'Find a partner person by name or email. Returns person_id, full_name, email. Use to get the person_id before awarding a certificate.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'Name or email' } }, required: ['query'] }
        },
        {
            name: 'list_certificate_designs',
            description: 'List available certificate designs. Returns id (type_id), name, category. Use to get the type_id before awarding a certificate.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_tickets',
            description: 'Search support tickets by ticket number, subject, or status. Returns the ticket id, number, subject, and status. Use to get the ticket_id before updating a ticket status.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'Ticket number, subject text, or status' } }, required: ['query'] }
        },

        // ── OPERATOR: actions (prepared, then user must confirm in the UI) ──────
        {
            name: 'assign_prospect_rep',
            description: 'Prepare to assign a staff rep to a prospect/lead. Requires lead_id (from search_prospects) and rep_userid (from list_reps). This is NOT executed immediately — it is proposed for the user to confirm.',
            parameters: { type: 'object', properties: { lead_id: { type: 'string' }, rep_userid: { type: 'string' } }, required: ['lead_id', 'rep_userid'] }
        },
        {
            name: 'award_certificate',
            description: 'Prepare to award a certificate to a partner. Requires person_id (from find_partner_person) and type_id (from list_certificate_designs). Proposed for user confirmation, not executed immediately.',
            parameters: { type: 'object', properties: { person_id: { type: 'string' }, type_id: { type: 'string' } }, required: ['person_id', 'type_id'] }
        },
        {
            name: 'update_ticket_status',
            description: 'Prepare to change a support ticket status. Requires ticket_id and status (open, in_progress, waiting, resolved, closed). Proposed for user confirmation, not executed immediately.',
            parameters: { type: 'object', properties: { ticket_id: { type: 'string' }, status: { type: 'string' } }, required: ['ticket_id', 'status'] }
        },
        {
            name: 'find_merchant',
            description: 'Find a merchant by DBA name or merchant id (MID). Returns the merchant uuid (id), merchant_id, dba_name, status. Use to get the id (uuid) before adding a merchant note or creating a task.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'DBA name or MID' } }, required: ['query'] }
        },
        {
            name: 'add_partner_note',
            description: 'Prepare to add an internal note to a partner. Requires person_id (from find_partner_person) and body. Proposed for confirmation.',
            parameters: { type: 'object', properties: { person_id: { type: 'string' }, body: { type: 'string' }, title: { type: 'string' } }, required: ['person_id', 'body'] }
        },
        {
            name: 'add_merchant_note',
            description: 'Prepare to add an internal note to a merchant. Requires merchant_id (the UUID from find_merchant) and body. Proposed for confirmation.',
            parameters: { type: 'object', properties: { merchant_id: { type: 'string', description: 'merchant UUID (id) from find_merchant' }, body: { type: 'string' }, title: { type: 'string' } }, required: ['merchant_id', 'body'] }
        },
        {
            name: 'create_task',
            description: 'Prepare to create a task on a merchant, optionally assigned to a staff member. Requires title and merchant_id (UUID from find_merchant). Optional assigned_to (userid from list_reps), due_date (YYYY-MM-DD), priority (low/medium/high), body. Proposed for confirmation.',
            parameters: { type: 'object', properties: { title: { type: 'string' }, merchant_id: { type: 'string', description: 'merchant UUID' }, assigned_to: { type: 'string' }, due_date: { type: 'string' }, priority: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'merchant_id'] }
        },
        {
            name: 'add_ticket_comment',
            description: 'Prepare to post a staff comment on a ticket. Requires ticket_id (from search_tickets) and body. Set is_internal:true for a private note (partner is NOT notified); otherwise the partner is notified. Proposed for confirmation.',
            parameters: { type: 'object', properties: { ticket_id: { type: 'string' }, body: { type: 'string' }, is_internal: { type: 'boolean' } }, required: ['ticket_id', 'body'] }
        },
        {
            name: 'send_prospect_invite',
            description: 'Prepare to email a prospect their portal account-setup invite. Requires lead_id (from search_prospects). Refuses if they already have an account. Proposed for confirmation — this SENDS AN EMAIL.',
            parameters: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'] }
        },
        {
            name: 'notify_partner',
            description: 'Prepare to send an in-app portal notification (bell) to a partner. Requires person_id (from find_partner_person) and title and/or body. Optional link. Proposed for confirmation. In-app only (no email).',
            parameters: { type: 'object', properties: { person_id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, link: { type: 'string' } }, required: ['person_id'] }
        },
        {
            name: 'update_merchant_status',
            description: 'DESTRUCTIVE. Prepare to change a merchant account_status (Approved, Suspended, Terminated, Pending, PCI Non-Compliant, Approved - Collections). Requires merchant_id (UUID from find_merchant). Fires the merchant.status_changed webhook. Super-admin only; user must type CONFIRM.',
            parameters: { type: 'object', properties: { merchant_id: { type: 'string', description: 'merchant UUID' }, status: { type: 'string' } }, required: ['merchant_id', 'status'] }
        },
        {
            name: 'delete_prospect',
            description: 'DESTRUCTIVE and irreversible. Prepare to delete a prospect and revoke their portal access. Requires lead_id (from search_prospects). User must type CONFIRM.',
            parameters: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'] }
        },
        {
            name: 'delete_task',
            description: 'DESTRUCTIVE. Prepare to delete a task. Requires task_id. Admin only; user must type CONFIRM.',
            parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
        },
        {
            name: 'delete_ticket',
            description: 'DESTRUCTIVE (archived/restorable). Prepare to delete a support ticket. Requires ticket_id (from search_tickets). Needs ticket-delete permission; user must type CONFIRM.',
            parameters: { type: 'object', properties: { ticket_id: { type: 'string' } }, required: ['ticket_id'] }
        }
    ];

    // ── TOOL EXECUTOR ─────────────────────────────────────────────────────────
    async function executeTool(name, args) {
        try {
            // Operator actions: PROPOSE only (execution happens after the user confirms).
            if (ACTION_SPECS[name]) {
                const spec = ACTION_SPECS[name];
                if (!opEnabled) return { error: 'Operator mode is off. An admin can enable "Jarvis Operator" in Secret Dungeon → Feature Flags.' };
                if (!spec.access(actor)) return { error: 'You do not have permission to perform this action.' };
                let label = name; try { label = await spec.describe(args || {}); } catch (e) {}
                pendingAction = { name, args: args || {}, label, dangerous: !!spec.dangerous };
                return { proposed: true, requires_confirmation: true, dangerous: !!spec.dangerous, summary: label, note: (spec.dangerous ? 'This is a DESTRUCTIVE action — the user must type CONFIRM in the UI. ' : '') + 'Prepared. Tell the user exactly what will happen and that they must confirm in the UI. Do NOT claim it is done.' };
            }
            switch (name) {

                // ── MERCHANTS ────────────────────────────────────────────────
                case 'get_merchant_overview': {
                    const [
                        { count: approved },
                        { count: suspended },
                        { count: terminated },
                        { count: pending },
                        { count: pciNonCompliant }
                    ] = await Promise.all([
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Approved'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Suspended'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Terminated'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Pending'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'PCI Non-Compliant')
                    ]);
                    // Top 5 by 30-day volume
                    const { data: topMerchants } = await supabase.from('merchants')
                        .select('dba_name, merchant_id, volume_30_day, agent_name')
                        .eq('account_status', 'Approved')
                        .order('volume_30_day', { ascending: false })
                        .limit(5);
                    // At-risk count
                    const { data: allActive } = await supabase.from('merchants')
                        .select('volume_30_day, volume_90_day')
                        .eq('account_status', 'Approved')
                        .gt('volume_90_day', 0);
                    const atRiskCount = (allActive || []).filter(m => {
                        const baseline = parseFloat(m.volume_90_day) / 3;
                        return baseline > 0 && (1 - parseFloat(m.volume_30_day) / baseline) >= 0.15;
                    }).length;
                    return { approved, suspended, terminated, pending, pci_non_compliant: pciNonCompliant, at_risk_count: atRiskCount, top_merchants_by_volume: topMerchants || [] };
                }

                case 'search_merchants': {
                    const limit = args.limit || 10;
                    const isNumeric = /^\d+$/.test(args.query);
                    let q = supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_name, merchant_state, last_batch_date')
                        .limit(limit);
                    if (isNumeric) q = q.ilike('merchant_id', `%${args.query}%`);
                    else q = q.ilike('dba_name', `%${args.query}%`);
                    const { data } = await q;
                    return { merchants: data || [], count: (data || []).length };
                }

                case 'get_merchant_detail': {
                    const key = String(args.merchant_id || '').trim();
                    const cols = 'id, merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_name, agent_id, merchant_phone, merchant_state, merchant_email, enrollment_date, last_batch_date';
                    // Match by MID first (may be duplicated → take first), then by DBA name.
                    let m = null;
                    let r = await supabase.from('merchants').select(cols).eq('merchant_id', key).order('created_at', { ascending: false }).limit(1).maybeSingle();
                    m = r.data;
                    if (!m) { const r2 = await supabase.from('merchants').select(cols).ilike('dba_name', `%${key}%`).limit(1).maybeSingle(); m = r2.data; }
                    if (!m) return { error: `No merchant found for "${key}".` };
                    const baseline = m.volume_90_day ? parseFloat(m.volume_90_day) / 3 : 0;
                    const dropPct = baseline > 0 ? Math.round((1 - parseFloat(m.volume_30_day) / baseline) * 100) : 0;
                    // deployments/returns are keyed by the merchant UUID (m.id), not the MID.
                    let deployments = [], returns_ = [];
                    try { const d = await supabase.from('deployments').select('deployment_id, status, target_deployment_date, tracking_id, equipments:equipment_id(terminal_type, serial_number)').eq('merchant_id', m.id).order('created_at', { ascending: false }).limit(5); deployments = d.data || []; } catch (e) {}
                    try { const rr = await supabase.from('returns').select('return_id, status, return_reason, created_at').eq('merchant_id', m.id).order('created_at', { ascending: false }).limit(5); returns_ = rr.data || []; } catch (e) {}
                    // Resolve the actual PARTNER (person) behind the agent id_string — the
                    // merchants.agent_name is the writing agent, which may differ from the partner.
                    let partner_name = null;
                    try {
                        const { data: ident } = await supabase.from('agent_identifiers').select('agent_id').eq('id_string', m.agent_id).maybeSingle();
                        if (ident && ident.agent_id) {
                            const { data: ag } = await supabase.from('agents').select('parent_agent_id').eq('id', ident.agent_id).maybeSingle();
                            if (ag && ag.parent_agent_id) { const { data: p } = await supabase.from('persons').select('full_name').eq('id', ag.parent_agent_id).maybeSingle(); partner_name = p ? p.full_name : null; }
                        }
                    } catch (e) {}
                    return { ...m, agent_id_string: m.agent_id, writing_agent_name: m.agent_name, partner_name, volume_baseline_monthly: Math.round(baseline), volume_drop_pct: dropPct, recent_deployments: deployments, recent_returns: returns_ };
                }

                case 'get_at_risk_merchants': {
                    const limit = args.limit || 20;
                    const minDrop = args.min_drop_pct || 15;
                    const { data } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, volume_30_day, volume_90_day, agent_name, account_status, merchant_state')
                        .eq('account_status', 'Approved').gt('volume_90_day', 0).limit(500);
                    const atRisk = (data || [])
                        .map(m => {
                            const baseline = parseFloat(m.volume_90_day) / 3;
                            if (!baseline) return null;
                            const drop = Math.round((1 - parseFloat(m.volume_30_day) / baseline) * 100);
                            if (drop < minDrop) return null;
                            return { ...m, drop_pct: drop, baseline_monthly: Math.round(baseline) };
                        })
                        .filter(Boolean)
                        .sort((a, b) => b.drop_pct - a.drop_pct)
                        .slice(0, limit);
                    return { at_risk: atRisk, count: atRisk.length };
                }

                case 'get_merchants_by_status': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, agent_name, merchant_state, enrollment_date')
                        .eq('account_status', args.status)
                        .order('dba_name').limit(limit);
                    return { merchants: data || [], count: (data || []).length, status: args.status };
                }

                // ── PARTNERS ──────────────────────────────────────────────────
                case 'get_partner_overview': {
                    const [
                        { count: totalPartners },
                        { count: portalActive },
                        { count: portalSetup }
                    ] = await Promise.all([
                        supabase.from('persons').select('*', { count: 'exact', head: true }),
                        supabase.from('persons').select('*', { count: 'exact', head: true }).eq('is_portal_active', true),
                        supabase.from('persons').select('*', { count: 'exact', head: true }).eq('portal_password_set', true)
                    ]);
                    // Top partners by merchant volume
                    const { data: stats } = await supabase.from('agent_stats')
                        .select('agent_id, merchant_count, total_volume_sum')
                        .order('total_volume_sum', { ascending: false }).limit(5);
                    return { total_partners: totalPartners, portal_invited: portalActive, portal_fully_setup: portalSetup, top_partners_by_volume: stats || [] };
                }

                case 'search_partners': {
                    const limit = args.limit || 10;
                    const { data: persons } = await supabase.from('persons')
                        .select('id, full_name, email, is_portal_active, portal_password_set, enrolled_at')
                        .ilike('full_name', `%${args.query}%`).limit(limit);
                    if (!persons?.length) return { partners: [], count: 0 };
                    const personIds = persons.map(p => p.id);
                    const { data: agents } = await supabase.from('agents').select('id, parent_agent_id').in('parent_agent_id', personIds);
                    const agentIds = (agents || []).map(a => a.id);
                    const { data: stats } = agentIds.length
                        ? await supabase.from('agent_stats').select('agent_id, merchant_count, total_volume_sum').in('agent_id', agentIds)
                        : { data: [] };
                    const partners = persons.map(p => {
                        const myAgentIds = (agents || []).filter(a => a.parent_agent_id === p.id).map(a => a.id);
                        const myStats = (stats || []).filter(s => myAgentIds.includes(s.agent_id));
                        const totalVolume = myStats.reduce((sum, s) => sum + (parseFloat(s.total_volume_sum) || 0), 0);
                        const merchantCount = myStats.reduce((sum, s) => sum + (s.merchant_count || 0), 0);
                        return { ...p, merchant_count: merchantCount, total_volume: Math.round(totalVolume) };
                    });
                    return { partners, count: partners.length };
                }

                case 'get_partner_detail': {
                    const { data: person } = await supabase.from('persons')
                        .select('id, full_name, email, is_portal_active, portal_password_set, enrolled_at')
                        .eq('id', args.person_id).single();
                    if (!person) return { error: 'Partner not found' };
                    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', args.person_id);
                    if (!agents?.length) return { ...person, merchants: [], at_risk: [] };
                    const agentIds = agents.map(a => a.id);
                    const { data: identifiers } = await supabase.from('agent_identifiers').select('id_string').in('agent_id', agentIds);
                    const agentIdStrings = (identifiers || []).map(i => i.id_string);
                    if (!agentIdStrings.length) return { ...person, merchants: [], at_risk: [] };
                    const { data: merchants } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day')
                        .in('agent_id', agentIdStrings).limit(50);
                    const atRisk = (merchants || []).filter(m => {
                        const baseline = parseFloat(m.volume_90_day) / 3;
                        return baseline > 0 && (1 - parseFloat(m.volume_30_day) / baseline) >= 0.15;
                    }).map(m => ({ dba_name: m.dba_name, merchant_id: m.merchant_id, drop_pct: Math.round((1 - parseFloat(m.volume_30_day) / (parseFloat(m.volume_90_day) / 3)) * 100) }));
                    return { ...person, total_merchants: (merchants || []).length, merchants: (merchants || []).slice(0, 10), at_risk_merchants: atRisk };
                }

                case 'get_partners_without_portal': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('persons')
                        .select('id, full_name, email, enrolled_at')
                        .eq('is_portal_active', false)
                        .order('enrolled_at', { ascending: false })
                        .limit(limit);
                    return { partners: data || [], count: (data || []).length };
                }

                // ── DEPLOYMENTS ────────────────────────────────────────────────
                case 'get_deployment_overview': {
                    const statuses = ['Pending', 'In Progress', 'Delivered', 'Cancelled'];
                    const counts = await Promise.all(statuses.map(s =>
                        supabase.from('deployments').select('*', { count: 'exact', head: true }).eq('status', s)
                    ));
                    const result = {};
                    statuses.forEach((s, i) => { result[s.toLowerCase().replace(' ', '_')] = counts[i].count || 0; });
                    // Overdue (pending past target date)
                    const { count: overdue } = await supabase.from('deployments')
                        .select('*', { count: 'exact', head: true })
                        .eq('status', 'Pending')
                        .lt('target_deployment_date', new Date().toISOString());
                    result.overdue_pending = overdue || 0;
                    return result;
                }

                case 'get_deployments': {
                    const limit = args.limit || 15;
                    let q = supabase.from('deployments')
                        .select('deployment_id, status, target_deployment_date, purchase_type, merchants:merchant_id(dba_name, merchant_id), equipments:equipment_id(terminal_type, serial_number)')
                        .order('target_deployment_date', { ascending: false })
                        .limit(limit);
                    if (args.status) q = q.eq('status', args.status);
                    const { data } = await q;
                    return { deployments: data || [], count: (data || []).length };
                }

                // ── INVENTORY ──────────────────────────────────────────────────
                case 'get_inventory_overview': {
                    const [
                        { count: total },
                        { count: stocked },
                        { count: deployed },
                        { count: inRepair },
                        { count: decommissioned }
                    ] = await Promise.all([
                        supabase.from('equipments').select('*', { count: 'exact', head: true }),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'stocked').eq('current_location', 'Warsaw Office'),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'deployed'),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('current_location', 'Warsaw Repairs'),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'decommissioned')
                    ]);
                    // Breakdown by terminal type (stocked)
                    const { data: byType } = await supabase.from('equipments')
                        .select('terminal_type')
                        .eq('status', 'stocked');
                    const typeBreakdown = {};
                    (byType || []).forEach(e => {
                        const t = e.terminal_type || 'Unknown';
                        typeBreakdown[t] = (typeBreakdown[t] || 0) + 1;
                    });
                    return { total, stocked, deployed, in_repair: inRepair, decommissioned, stocked_by_type: typeBreakdown };
                }

                case 'search_inventory': {
                    const limit = args.limit || 15;
                    const { data } = await supabase.from('equipments')
                        .select('id, serial_number, terminal_type, status, current_location, condition, received_date')
                        .or(`serial_number.ilike.%${args.query}%,terminal_type.ilike.%${args.query}%`)
                        .limit(limit);
                    return { equipment: data || [], count: (data || []).length };
                }

                case 'get_inventory_by_location': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('equipments')
                        .select('id, serial_number, terminal_type, status, condition, received_date')
                        .ilike('current_location', `%${args.location}%`)
                        .limit(limit);
                    return { equipment: data || [], count: (data || []).length, location: args.location };
                }

                // ── RETURNS ────────────────────────────────────────────────────
                case 'get_returns_overview': {
                    const [
                        { count: open },
                        { count: pending },
                        { count: completed },
                        { count: defective }
                    ] = await Promise.all([
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('status', 'open'),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('status', 'pending'),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('status', 'completed'),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('condition', '%defective%')
                    ]);
                    const { data: recent } = await supabase.from('returns')
                        .select('return_id, merchant_name, status, return_reason, created_at')
                        .order('created_at', { ascending: false }).limit(5);
                    return { open, pending, completed, defective_units: defective, recent: recent || [] };
                }

                case 'get_returns': {
                    const limit = args.limit || 15;
                    let q = supabase.from('returns')
                        .select('id, return_id, merchant_name, merchant_id, status, return_reason, condition, destination, created_at')
                        .order('created_at', { ascending: false })
                        .limit(limit);
                    if (args.status) q = q.ilike('status', args.status);
                    else q = q.or('status.ilike.open,status.ilike.pending');
                    const { data } = await q;
                    return { returns: data || [], count: (data || []).length };
                }

                // ── UNIVERSAL QUERY ──────────────────────────────────────────
                case 'query_records': {
                    const ecfg = JARVIS_ENTITIES[args.entity];
                    if (!ecfg) return { error: 'Unknown entity. Use one of: ' + Object.keys(JARVIS_ENTITIES).join(', ') };
                    const allowedDates = [ecfg.date].concat(ecfg.dateAlt || []);
                    const dateField = (args.date_field && allowedDates.indexOf(args.date_field) >= 0) ? args.date_field : ecfg.date;
                    const range = jarvisDateRange(args.since, args.until);

                    // Prime49 resolution (no direct column on merchants/persons).
                    let primeIdStrings = null, primePersonIds = null;
                    if (args.prime49_only) {
                        if (ecfg.prime49 !== 'merchant' && ecfg.prime49 !== 'partner') return { error: 'prime49_only is only supported for merchants and partners.' };
                        const { data: pi } = await supabase.from('agent_identifiers').select('id_string, agent_id').eq('prime49', true).limit(10000);
                        if (ecfg.prime49 === 'merchant') {
                            primeIdStrings = [...new Set((pi || []).map(x => x.id_string).filter(Boolean))];
                            if (!primeIdStrings.length) primeIdStrings = ['__none__'];
                        } else {
                            const agentUuids = [...new Set((pi || []).map(x => x.agent_id).filter(Boolean))];
                            let persons = [];
                            if (agentUuids.length) { const { data: ag } = await supabase.from('agents').select('parent_agent_id').in('id', agentUuids); persons = [...new Set((ag || []).map(a => a.parent_agent_id).filter(Boolean))]; }
                            primePersonIds = persons.length ? persons : ['__none__'];
                        }
                    }

                    const countOnly = !!args.count_only;
                    let q = supabase.from(ecfg.table).select(countOnly ? 'id' : ecfg.select, countOnly ? { count: 'exact', head: true } : { count: 'exact' });
                    if (range.gte) q = q.gte(dateField, range.gte);
                    if (range.lt) q = q.lt(dateField, range.lt);
                    if (args.status && ecfg.statusCol) q = q.ilike(ecfg.statusCol, String(args.status));
                    if (primeIdStrings) q = q.in('agent_id', primeIdStrings);
                    if (primePersonIds) q = q.in('id', primePersonIds);
                    q = q.order(dateField, { ascending: false, nullsFirst: false }).limit(countOnly ? 1 : Math.min(args.limit || 15, 50));
                    const { data, count, error } = await q;
                    if (error) return { error: error.message };
                    const meta = { entity: args.entity, count: count || 0, since: args.since || 'all time', date_field: dateField, status: args.status || null, prime49_only: !!args.prime49_only };
                    return countOnly ? meta : { ...meta, records: data || [] };
                }

                // ── OPERATOR read helpers ────────────────────────────────────
                case 'search_prospects': {
                    const q = String(args.query || '').replace(/[%,()]/g, ' ').trim();
                    if (q.length < 2) return { prospects: [] };
                    const { data } = await supabase.from('leads').select('id, full_name, email, status, assigned_rep').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(10);
                    return { prospects: data || [] };
                }
                case 'list_reps': {
                    const { data } = await supabase.from('app_users').select('userid, first_name, last_name, email, role').eq('is_active', true).order('first_name').limit(200);
                    return { reps: (data || []).map(u => ({ userid: u.userid, name: (`${u.first_name || ''} ${u.last_name || ''}`.trim()) || u.email, role: u.role || '' })) };
                }
                case 'find_partner_person': {
                    const q = String(args.query || '').replace(/[%,()]/g, ' ').trim();
                    if (q.length < 2) return { partners: [] };
                    const { data } = await supabase.from('persons').select('id, full_name, email').or(`full_name.ilike.%${q}%,email.ilike.%${q}%`).limit(10);
                    return { partners: data || [] };
                }
                case 'list_certificate_designs': {
                    const { data } = await supabase.from('app_settings').select('value').eq('key', 'cert_designs').maybeSingle();
                    let arr = []; try { arr = JSON.parse(data?.value || '[]'); } catch (e) { arr = []; }
                    return { designs: (Array.isArray(arr) ? arr : []).map(d => ({ id: d.id, name: d.name, category: d.category || 'payprotec', is_default: !!d.is_default })) };
                }
                case 'search_tickets': {
                    const q = String(args.query || '').replace(/[%,()]/g, ' ').trim();
                    if (q.length < 2) return { tickets: [] };
                    const { data } = await supabase.from('support_tickets')
                        .select('id, ticket_number, subject, status')
                        .or(`ticket_number.ilike.%${q}%,subject.ilike.%${q}%,status.ilike.%${q}%`)
                        .order('updated_at', { ascending: false }).limit(10);
                    return { tickets: data || [] };
                }

                case 'find_merchant': {
                    const q = String(args.query || '').replace(/[%,()]/g, ' ').trim();
                    if (q.length < 2) return { merchants: [] };
                    const isNum = /^\d+$/.test(q);
                    let mq = supabase.from('merchants').select('id, merchant_id, dba_name, account_status').limit(10);
                    mq = isNum ? mq.ilike('merchant_id', `%${q}%`) : mq.ilike('dba_name', `%${q}%`);
                    const { data } = await mq;
                    return { merchants: data || [] };
                }

                default:
                    return { error: `Unknown tool: ${name}` };
            }
        } catch (e) {
            console.error(`[Jarvis Tool Error] ${name}:`, e.message);
            return { error: e.message };
        }
    }

    try {

        // ── LOAD KNOWLEDGE BASE ───────────────────────────────────────────────
        const { data: knowledgeRows } = await supabase
            .from('jarvis_knowledge')
            .select('topic, correct_logic')
            .order('created_at', { ascending: false })
            .limit(40);

        const knowledgeBlock = (knowledgeRows || []).length > 0
            ? '\n\nINTERNAL KNOWLEDGE BASE (always apply these rules and facts):\n' +
              (knowledgeRows || []).map(k => `• [${k.topic}] ${k.correct_logic}`).join('\n')
            : '';

        // ── CONVERSATION THREAD (create if none) ──────────────────────────────
        let conversationId = req.body.conversation_id || null;
        let conversationCreated = false;
        if (!conversationId) {
            const title = (String(query || '').replace(/\s+/g, ' ').trim().slice(0, 60)) || 'New chat';
            const { data: conv } = await supabase.from('jarvis_conversations').insert({ userid: userId, title }).select('id').single();
            conversationId = conv ? conv.id : null;
            conversationCreated = true;
        }

        // ── CHAT HISTORY (scoped to this conversation) ────────────────────────
        let histQ = supabase.from('chat_history').select('role, content').order('id', { ascending: false }).limit(40);
        histQ = conversationId ? histQ.eq('conversation_id', conversationId) : histQ.eq('userid', userId);
        const { data: history } = await histQ;

        const formattedHistory = (history || []).map(h => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: h.content }]
        })).reverse();
        // Gemini requires history to begin with a 'user' turn — drop any leading model turns.
        while (formattedHistory.length && formattedHistory[0].role !== 'user') formattedHistory.shift();

        // ── SYSTEM PROMPT ─────────────────────────────────────────────────────
        const systemInstruction = `You are JARVIS, the AI business intelligence agent for PayProTec's merchant management console. Address the user as ${userName || 'Sir'}.

Your focus areas: Merchants, Partners, Deployments, Inventory, and Returns. You have live database access via tools.

CRITICAL CONVERSATION RULES:
1. Always read the full conversation history before deciding what to do.
2. For follow-up questions ("review it", "what about that merchant", "tell me more", "can you analyze it"), use the data already retrieved in previous messages — do NOT call tools again or ask "what would you like to review?" You already have the context.
3. Pronouns like "it", "that", "this merchant", "the above" always refer to the most recently discussed subject in the conversation history.
4. Only call tools when genuinely NEW data is needed (e.g. a different merchant, a new topic, or refreshing stale data).
4b. MEMORY: the messages above ARE your memory of this ongoing conversation with the user (they persist across logins). If the user asks "what did I ask", "do you remember…", or "recap", answer from that history. Only say you don't recall something if it genuinely is not in the history above.
5. For greetings or fully off-topic messages, respond briefly.
6. End substantive answers with "**Suggested Actions:**" listing 2-4 concrete next steps.

TOOL USAGE:
- Call tools for fresh data lookups
- Do NOT call tools when you already have the data from this conversation
- For ANY "how many / which / list / added / new / recently / this week / last month / Prime49 / by status" question about merchants, partners, prospects, POS leads, deployments, returns, or tickets — use the query_records tool (set count_only:true for "how many"). It supports time windows (last_7_days, this_month, etc.), a status filter, and prime49_only. You can call it multiple times (e.g. once for merchants and once for partners) and combine the answers.

Formatting: use **bold** for names/numbers, bullet lists for items, keep responses concise.

NAVIGATION ACTIONS — when suggesting a page to visit, use EXACTLY these URL formats (never invent paths):
- Merchant list: → View all merchants (url:/merchants-dashboard.html)
- Search merchants by name: → Search for [name] in merchants (url:/merchants-dashboard.html?q=[name])
- Filter merchants by status: → View [status] merchants (url:/merchants-dashboard.html?filterBy=[status])
- Partners list: → View all partners (url:/partners-dashboard.html)
- Search partners: → Search for [name] in partners (url:/partners-dashboard.html?q=[name])
- Deployments: → View deployments (url:/deployments-dashboard.html)
- Search deployments: → Search deployments (url:/deployments-dashboard.html?q=[term])
- Inventory/Equipment: → View inventory (url:/equipments-dashboard.html)
- Search inventory: → Search inventory (url:/equipments-dashboard.html?q=[term])
- Returns: → View returns (url:/returns-dashboard.html)
- Search returns: → Search returns (url:/returns-dashboard.html?q=[term])
Only include navigation actions when they are genuinely useful. Use real names/values in the URL query params, not placeholder text like [name].

OPERATOR ACTIONS${opEnabled ? ' (ENABLED)' : ' (currently OFF — do not attempt)'}: You can PREPARE these write actions:
- assign_prospect_rep (needs lead_id via search_prospects + rep_userid via list_reps)
- send_prospect_invite (needs lead_id — SENDS AN EMAIL to the prospect)
- award_certificate (needs person_id via find_partner_person + type_id via list_certificate_designs) [super-admin only]
- add_partner_note (needs person_id via find_partner_person)
- notify_partner (needs person_id — sends an in-app bell to the partner)
- add_merchant_note (needs merchant UUID via find_merchant)
- create_task (needs title + merchant UUID via find_merchant; optional assigned_to via list_reps, due_date, priority)
- update_ticket_status (needs ticket_id via search_tickets)
- add_ticket_comment (needs ticket_id via search_tickets; a non-internal comment notifies the partner)
DESTRUCTIVE actions (the user will be required to TYPE "CONFIRM"): update_merchant_status (super-admin; fires a webhook), delete_prospect (irreversible), delete_task, delete_ticket (archived/restorable). Only propose these when the user clearly asks to delete or change a status; state plainly that it is destructive.
ALWAYS resolve exact ids with the read helpers FIRST, then call the action tool. Actions are NEVER executed immediately — they are proposed and the user must click Confirm. After calling an action tool, clearly state what you've prepared, mention any email/notification side effect, and that the user must confirm. NEVER say an action is complete/done — it isn't until the user confirms.` + knowledgeBlock;

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        // ── FOLLOW-UP DETECTION ───────────────────────────────────────────────
        // Only send to the tools-free path when the user is clearly asking for
        // commentary/assessment on data already shown — NOT when they're asking
        // for new data lookups ("analyze his merchants", "show me his volume", etc.)
        const followUpPhrases = /^(review it|summarize( it| that| this)?|tell me more|more detail|explain( it| that| this)?|what do you think|give me a summary|give me a review)/i;
        const isFollowUp = query.trim().length < 120 && followUpPhrases.test(query.trim());

        const hasLastResponse = !!(lastResponse && lastResponse.trim().length > 50);

        const toolCallsLog = [];
        let finalAnswer;

        if (isFollowUp && hasLastResponse) {
            // ── FOLLOW-UP PATH: no tools, assess data already shown ───────────
            // Uses a separate model instance with NO tools registered — Gemini
            // cannot call tools when they're not on the model instance.
            const prevResponse = lastResponse.slice(0, 2000);
            const followUpModel = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction: `You are JARVIS, a business intelligence assistant for PayProTec. Address the user as ${userName || 'Sir'}. You are providing an assessment of data that was already retrieved. Give a direct analytical opinion — comment on status, volume trends, risks, and recommended actions. Use **bold** for key data points. End with "**Suggested Actions:**" listing 2-3 concrete next steps.`
            });
            const r = await followUpModel.generateContent(
                `Previous JARVIS response containing the relevant data:\n"""\n${prevResponse}\n"""\n\nUser follow-up: ${query}\n\nProvide your analytical assessment of the data shown above.`
            );
            try { finalAnswer = r.response.text(); }
            catch { finalAnswer = 'Could not generate follow-up response. Please try rephrasing.'; }

        } else {
            // ── MAIN PATH: full agentic loop with tools ────────────────────────
            // The stored conversation (formattedHistory) is the source of truth for
            // memory — pass it directly so the model recalls the whole recent thread.
            const historyWithContext = formattedHistory;

            const model = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction,
                tools: [{ functionDeclarations }]
            });
            const chat = model.startChat({ history: historyWithContext });
            let result = await chat.sendMessage(query);
            let maxIterations = 8;
            let usedTools = false;

            while (maxIterations-- > 0) {
                let calls;
                try { calls = result.response.functionCalls(); } catch { calls = null; }
                if (!calls || calls.length === 0) break;
                usedTools = true;
                const toolResponses = [];
                for (const call of calls) {
                    toolCallsLog.push(call.name);
                    const toolResult = await executeTool(call.name, call.args || {});
                    toolResponses.push({ functionResponse: { name: call.name, response: toolResult } });
                }
                result = await chat.sendMessage(toolResponses);
            }
            try { finalAnswer = result.response.text(); }
            catch { finalAnswer = ''; }

            // Sometimes (esp. after tool calls) the model returns an empty text turn.
            // Nudge it once to write the answer from the data it just gathered.
            if (!finalAnswer || !finalAnswer.trim()) {
                try {
                    const r2 = await chat.sendMessage(usedTools
                        ? 'Now answer my question in plain text using the data you just retrieved. Be concise and use **bold** for the key numbers.'
                        : 'Please answer my previous question directly in plain text.');
                    finalAnswer = r2.response.text();
                } catch (e) { finalAnswer = ''; }
            }
            if (!finalAnswer || !finalAnswer.trim()) {
                finalAnswer = "I couldn't put together a response for that, Sir. Please try rephrasing, or ask me something more specific.";
            }
        }

        // ── EXTRACT NAVIGATION SUGGESTIONS ────────────────────────────────────
        const suggestions = [];
        const urlMatches = [...finalAnswer.matchAll(/→\s*([^\n(]+)\(url:([^)]+)\)/g)];
        for (const m of urlMatches) {
            suggestions.push({ label: m[1].trim().replace(/\*\*/g, ''), url: m[2].trim() });
        }
        const cleanAnswer = finalAnswer.replace(/\s*\(url:[^)]+\)/g, '');

        // ── PERSIST HISTORY (into this conversation) ──────────────────────────
        try {
            await supabase.from('chat_history').insert([
                { userid: userId, conversation_id: conversationId, role: 'user', content: query },
                { userid: userId, conversation_id: conversationId, role: 'assistant', content: cleanAnswer }
            ]);
            if (conversationId) await supabase.from('jarvis_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
        } catch { /* non-fatal */ }

        // Auto-title a brand-new conversation with a short AI summary of the first message.
        if (conversationCreated && conversationId) {
            try {
                const titleModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
                const tr = await titleModel.generateContent(`Write a very short 3-5 word title (Title Case, no quotes, no punctuation at the end) that summarizes this request:\n"${String(query).slice(0, 200)}"`);
                let title = '';
                try { title = tr.response.text().trim().replace(/^["'#\-\s]+|["'\s]+$/g, '').replace(/\n/g, ' ').slice(0, 60); } catch (e) { title = ''; }
                if (title) await supabase.from('jarvis_conversations').update({ title }).eq('id', conversationId);
            } catch (e) { /* keep the fallback title */ }
        }

        return res.status(200).json({
            answer: cleanAnswer,
            suggestions,
            tools_used: [...new Set(toolCallsLog)],
            pending_action: pendingAction,
            conversation_id: conversationId,
            conversation_created: conversationCreated
        });

    } catch (err) {
        console.error('[Jarvis Error]', err?.message || err);
        return res.status(200).json({
            answer: `I hit an error, ${userName || 'Sir'}: ${err?.message || 'Unknown error'}. Please check the server logs.`,
            suggestions: [],
            tools_used: []
        });
    }
}
