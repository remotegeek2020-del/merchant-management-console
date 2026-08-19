// CRM automation engine. Fired best-effort from events (contact created, form
// submitted, tag added, booking created). Loads enabled workflows for the CRM
// whose trigger matches, then runs each workflow's actions.
import { createClient } from '@supabase/supabase-js';
import { sendAgencyEmail } from './_agency-mail.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export const WORKFLOW_TRIGGERS = ['contact_created', 'form_submitted', 'tag_added', 'booking_created'];
export const WORKFLOW_ACTIONS = ['add_tag', 'set_status', 'assign_owner', 'create_task', 'create_note', 'send_email'];

// Simple {{first_name}} / {{name}} / {{email}} / {{company}} substitution for emails.
function fill(tpl, contact) {
    return String(tpl || '').replace(/\{\{\s*(first_name|last_name|name|email|company)\s*\}\}/g, (m, k) => {
        if (k === 'name') return [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '';
        return contact[k] || '';
    });
}

async function execAction(wf, ctx, contact, action) {
    const cfg = action.config || {};
    const subId = ctx.sub_account_id, portalId = ctx.portal_id, cid = ctx.contact_id;
    switch (action.type) {
        case 'add_tag': {
            if (!cfg.tag_id || !cid) return;
            const { data: t } = await supabase.from('crm_tags').select('id').eq('sub_account_id', subId).eq('id', cfg.tag_id).maybeSingle();
            if (t) await supabase.from('crm_contact_tags').upsert({ contact_id: cid, tag_id: cfg.tag_id }, { onConflict: 'contact_id,tag_id' });
            return;
        }
        case 'set_status': if (cid && cfg.status) await supabase.from('crm_contacts').update({ status: cfg.status }).eq('id', cid); return;
        case 'assign_owner': if (cid && cfg.person_id) await supabase.from('crm_contacts').update({ owner_person_id: cfg.person_id }).eq('id', cid); return;
        case 'create_task': {
            if (!cid) return;
            let due = null; const d = parseInt(cfg.days_due, 10);
            if (!isNaN(d)) due = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
            await supabase.from('crm_tasks').insert({ sub_account_id: subId, portal_id: portalId, contact_id: cid, title: (cfg.title || 'Follow up'), due_date: due });
            return;
        }
        case 'create_note': if (cid && cfg.body) await supabase.from('crm_notes').insert({ sub_account_id: subId, portal_id: portalId, contact_id: cid, body: fill(cfg.body, contact) }); return;
        case 'send_email': {
            if (!contact || !contact.email || !cfg.subject) return;
            const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#0a1628;line-height:1.6;">' + fill(cfg.body || '', contact).replace(/\n/g, '<br>') + '</div>';
            await sendAgencyEmail(portalId, { to: contact.email, subject: fill(cfg.subject, contact), html, text: fill(cfg.body || '', contact) });
            // Log as an outbound email in the conversation (best-effort).
            try { await supabase.from('crm_messages').insert({ sub_account_id: subId, portal_id: portalId, contact_id: cid, direction: 'outbound', channel: 'email', body: 'Subject: ' + fill(cfg.subject, contact) + '\n\n' + fill(cfg.body || '', contact) }); } catch (e) {}
            return;
        }
    }
}

// event: one of WORKFLOW_TRIGGERS. ctx: { sub_account_id, portal_id, contact_id, tag_id?, form_id? }
export async function runWorkflows(event, ctx) {
    try {
        if (!ctx || !ctx.sub_account_id) return;
        const { data: wfs } = await supabase.from('crm_workflows').select('*').eq('sub_account_id', ctx.sub_account_id).eq('enabled', true).eq('trigger', event);
        if (!wfs || !wfs.length) return;
        let contact = null;
        if (ctx.contact_id) { const { data: c } = await supabase.from('crm_contacts').select('*').eq('id', ctx.contact_id).maybeSingle(); contact = c || null; }
        for (const wf of wfs) {
            const tc = wf.trigger_config || {};
            if (event === 'tag_added' && tc.tag_id && tc.tag_id !== ctx.tag_id) continue;
            if (event === 'form_submitted' && tc.form_id && tc.form_id !== ctx.form_id) continue;
            let status = 'ok', detail = '';
            try { for (const a of (wf.actions || [])) await execAction(wf, ctx, contact || {}, a); }
            catch (e) { status = 'error'; detail = (e && e.message) || 'action failed'; }
            try {
                await supabase.from('crm_workflow_runs').insert({ workflow_id: wf.id, sub_account_id: ctx.sub_account_id, contact_id: ctx.contact_id || null, status, detail: detail || (wf.actions || []).length + ' action(s)' });
                await supabase.from('crm_workflows').update({ run_count: (wf.run_count || 0) + 1 }).eq('id', wf.id);
            } catch (e) {}
        }
    } catch (e) { /* automation is best-effort, never blocks the triggering event */ }
}
