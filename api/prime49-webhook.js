// ── Prime49 conversion webhook ───────────────────────────────────────────────
// Real-time, reliable alternative to the in-modal postMessage guess (which
// was found to never fire in practice — HighLevel doesn't document that
// contract). Staff wire this up in HighLevel as a Workflow → Webhook action.
// The secret is generated PER CAMPAIGN (prime49_configs.webhook_secret) and
// shown directly in the campaign editor — no Vercel access needed. Path A
// and Path B get their own separate URLs/sections in the editor (the `path`
// param below), so a Path A calendar booking can never be mismatched onto a
// Path B submission for the same contact, or vice versa:
//
//   Path A (existing partner) — its own calendar/form:
//      → https://<host>/api/prime49-webhook?campaign_id=<id>&secret=<secret>&via=calendar&path=existing
//      → https://<host>/api/prime49-webhook?campaign_id=<id>&secret=<secret>&via=form&path=existing
//   Path B (prospective partner) — its own calendar/form:
//      → https://<host>/api/prime49-webhook?campaign_id=<id>&secret=<secret>&via=calendar&path=prospective
//      → https://<host>/api/prime49-webhook?campaign_id=<id>&secret=<secret>&via=form&path=prospective
//
// Either workflow's webhook body just needs the contact id — HighLevel's
// webhook action includes `{{contact.id}}` by default in its payload
// (as `contact_id` or nested under `contact.id` depending on payload
// version), which is exactly what we already store as hl_contact_id on
// the submission. Matches the most recent un-converted submission for that
// contact, campaign, AND path.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const campaignId = req.query?.campaign_id;
    const provided = req.query?.secret || req.headers['x-webhook-secret'];
    if (!campaignId || !provided) return res.status(401).json({ success: false, message: 'Missing campaign_id or secret.' });

    const { data: cfg } = await supabase.from('prime49_configs').select('webhook_secret').eq('campaign_id', campaignId).maybeSingle();
    if (!cfg || !cfg.webhook_secret || cfg.webhook_secret !== provided) {
        return res.status(401).json({ success: false, message: 'Invalid campaign id or secret.' });
    }

    // Always resolve to 200 below this point — HighLevel retries on non-2xx,
    // and a malformed/irrelevant payload isn't worth a retry storm.
    try {
        let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
        body = body || {};
        const via = req.query?.via === 'form' ? 'form' : 'calendar';
        const path = req.query?.path === 'existing' ? 'existing' : (req.query?.path === 'prospective' ? 'prospective' : null);
        const contactId = body.contact_id || body.contactId || (body.contact && body.contact.id) || '';
        if (!contactId) return res.status(200).json({ success: false, message: 'No contact id in payload.' });

        let q = supabase.from('prime49_submissions')
            .select('id').eq('campaign_id', campaignId).eq('hl_contact_id', contactId).eq('converted', false);
        if (path) q = q.eq('path', path);
        const { data: sub } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (sub) {
            await supabase.from('prime49_submissions').update({
                converted: true, converted_via: via, converted_at: new Date().toISOString()
            }).eq('id', sub.id);
            return res.status(200).json({ success: true, matched: sub.id });
        }
        return res.status(200).json({ success: true, matched: null });
    } catch (e) {
        console.error('[prime49-webhook]', e.message);
        return res.status(200).json({ success: false, message: 'error' });
    }
}
