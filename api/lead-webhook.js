// ── Lead intake webhook ──────────────────────────────────────────────────────
// Add this URL as a "Webhook" action in a HighLevel workflow. Each fire creates
// (or enriches) a prospect in the Lead Portal.
//
//   https://<host>/api/lead-webhook?secret=<LEAD_WEBHOOK_SECRET>&invite=false
//
//   invite=false → just create the prospect (default)
//   invite=true  → create the prospect AND email them the account-setup link
//
// Secured by the LEAD_WEBHOOK_SECRET env var. Always returns 200 (even on
// errors) so HighLevel doesn't retry-storm.
import { createClient } from '@supabase/supabase-js';
import { sendLeadInvite } from './_lead-invite.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pick(...vals) { for (const v of vals) { if (v != null && String(v).trim() !== '') return String(v).trim(); } return ''; }

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST only' });
    // Auth
    const secret = req.query.secret || req.headers['x-webhook-secret'];
    const expected = process.env.LEAD_WEBHOOK_SECRET;
    if (!expected) return res.status(200).json({ success: false, message: 'LEAD_WEBHOOK_SECRET not configured' });
    if (secret !== expected) return res.status(401).json({ success: false, message: 'Invalid secret' });

    try {
        const b = req.body || {};
        const c = (b.contact && typeof b.contact === 'object') ? b.contact : b; // HL may nest under "contact"
        const email = pick(c.email, b.email).toLowerCase();
        if (!email || !EMAIL_RE.test(email)) return res.status(200).json({ success: false, message: 'No valid email in payload' });
        const name = pick(c.full_name, b.full_name, `${pick(c.first_name, b.first_name)} ${pick(c.last_name, b.last_name)}`.trim(), c.name, b.name) || email;
        const phone = pick(c.phone, b.phone);
        const contactId = pick(c.contact_id, c.id, b.contact_id, b.id) || null;

        const mode = String(req.query.invite || req.query.mode || '').toLowerCase();
        const doInvite = ['1', 'true', 'yes', 'invite'].includes(mode);

        const { data: existing } = await supabase.from('leads')
            .select('id, phone, full_name, ghl_contact_id, password_hash').eq('email', email).maybeSingle();

        if (existing) {
            const patch = {};
            if (!existing.ghl_contact_id && contactId) patch.ghl_contact_id = contactId;
            if (!existing.phone && phone) patch.phone = phone;
            if (!existing.full_name && name) patch.full_name = name;
            if (Object.keys(patch).length) await supabase.from('leads').update(patch).eq('id', existing.id);
            // Never re-invite an already-active account.
            let invited = false;
            if (doInvite && !existing.password_hash) invited = await sendLeadInvite(supabase, { id: existing.id, full_name: patch.full_name || existing.full_name || name, email }, req.headers.host);
            return res.status(200).json({ success: true, action: 'updated', invited });
        }

        const { data: newLead, error } = await supabase.from('leads').insert({
            email, full_name: name, phone, ghl_contact_id: contactId,
            source: 'webhook', status: 'new', onboarding_completed: false
        }).select('id, full_name, email').single();
        if (error) return res.status(200).json({ success: false, message: error.message });

        let invited = false;
        if (doInvite && newLead) invited = await sendLeadInvite(supabase, newLead, req.headers.host);
        return res.status(200).json({ success: true, action: 'created', invited });
    } catch (e) {
        // Swallow → 200 so HighLevel doesn't retry endlessly.
        return res.status(200).json({ success: false, message: 'Server error: ' + (e.message || 'unknown') });
    }
}
