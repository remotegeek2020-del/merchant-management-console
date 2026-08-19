// PUBLIC lead-capture form endpoint (no auth — anyone can view a form and submit).
// A submission creates a crm_contact in the form's CRM (sub_account_id). Only the
// bare minimum is exposed publicly (form name, fields, submit message).
import { createClient } from '@supabase/supabase-js';
import { runWorkflows } from './_automation.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const STANDARD_KEYS = ['first_name', 'last_name', 'email', 'phone', 'company', 'title'];

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const body = req.body || {};
    const action = body.action || (req.method === 'GET' ? 'get_form' : null);
    const formId = body.form_id || (req.query && req.query.f);
    try {
        if (!formId) return res.status(400).json({ success: false, message: 'Missing form.' });
        const { data: form } = await supabase.from('crm_forms').select('*').eq('id', formId).maybeSingle();
        if (!form) return res.status(404).json({ success: false, message: 'Form not found.' });

        if (action === 'get_form') {
            // Public-safe subset only.
            return res.status(200).json({ success: true, form: { id: form.id, name: form.name, fields: form.fields || [], submit_message: form.submit_message, redirect_url: form.redirect_url } });
        }

        if (action === 'submit_form') {
            const values = body.values || {};
            const fields = form.fields || [];
            // required check
            for (const fld of fields) {
                if (fld.required && !String(values[fld.key] == null ? '' : values[fld.key]).trim()) {
                    return res.status(400).json({ success: false, message: (fld.label || 'A field') + ' is required.' });
                }
            }
            const row = { sub_account_id: form.sub_account_id, portal_id: form.portal_id, source: 'Form: ' + form.name, status: 'active', custom: {} };
            fields.forEach(fld => {
                const v = values[fld.key];
                if (v == null || v === '') return;
                if (fld.standard && STANDARD_KEYS.includes(fld.key)) row[fld.key] = v;
                else row.custom[fld.key] = v;
            });
            // must capture at least one identifier
            if (!row.first_name && !row.last_name && !row.email && !row.phone && Object.keys(row.custom).length === 0) {
                return res.status(400).json({ success: false, message: 'Please fill in the form.' });
            }
            const { data: created, error } = await supabase.from('crm_contacts').insert(row).select('id').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not submit. Please try again.' });
            // best-effort submission counter
            try { await supabase.from('crm_forms').update({ submissions: (form.submissions || 0) + 1 }).eq('id', form.id); } catch (e) {}
            // Fire automations (form_submitted + contact_created).
            const wfCtx = { sub_account_id: form.sub_account_id, portal_id: form.portal_id, contact_id: created && created.id, form_id: form.id };
            runWorkflows('form_submitted', wfCtx); runWorkflows('contact_created', wfCtx);
            return res.status(200).json({ success: true, message: form.submit_message || 'Thanks! We\'ll be in touch shortly.', redirect_url: form.redirect_url || null });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
}
