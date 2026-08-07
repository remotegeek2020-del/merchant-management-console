// Shared partner-notification helper. Writes a row into `notifications` that the
// partner portal bell (api/partner-data.js get_notifications) reads. Best-effort:
// never throws, so it can be dropped into any write path without risk.
//
// notifyPartner(supabase, {
//   personId,            // partner person_id (required)
//   type,                // e.g. 'ticket_reply' | 'ticket_update' | 'shipment_delivered'
//   title, body, link,   // display
//   actorName,           // who triggered it
//   referenceId          // optional: dedupes repeat events (e.g. deployment/ticket id)
// })
export async function notifyPartner(supabase, opts) {
    try {
        opts = opts || {};
        if (!opts.personId) return;
        const rid = String(opts.personId);
        const ref = (opts.referenceId != null && opts.referenceId !== '') ? String(opts.referenceId) : null;

        // Dedupe: skip if an identical (partner, type, reference) notification exists.
        if (ref) {
            const { data: existing } = await supabase.from('notifications')
                .select('id').eq('recipient_id', rid).eq('recipient_type', 'partner')
                .eq('type', String(opts.type || '')).eq('reference_id', ref).limit(1).maybeSingle();
            if (existing) return;
        }
        await supabase.from('notifications').insert({
            recipient_id: rid,
            recipient_type: 'partner',
            type: String(opts.type || 'update'),
            title: String(opts.title || '').slice(0, 200),
            body: String(opts.body || '').slice(0, 500),
            link: opts.link ? String(opts.link).slice(0, 300) : null,
            actor_name: String(opts.actorName || 'PayProTec').slice(0, 120),
            reference_id: ref,
            is_read: false
        });
    } catch (e) {
        // best-effort — a failed notification must never break the caller
    }
}

// Resolve the partner person_id that owns a merchant, via the
// merchant.agent_id (id_string) → agent_identifiers → agents.parent_agent_id chain.
// Returns null if it can't be resolved. Best-effort.
export async function partnerForMerchant(supabase, merchantId) {
    try {
        if (!merchantId) return null;
        const { data: m } = await supabase.from('merchants').select('agent_id').eq('id', merchantId).maybeSingle();
        const idStr = m && m.agent_id;
        if (!idStr) return null;
        const { data: ident } = await supabase.from('agent_identifiers').select('agent_id').eq('id_string', idStr).maybeSingle();
        if (!ident || !ident.agent_id) return null;
        const { data: agent } = await supabase.from('agents').select('parent_agent_id').eq('id', ident.agent_id).maybeSingle();
        return (agent && agent.parent_agent_id) || null;
    } catch (e) { return null; }
}
