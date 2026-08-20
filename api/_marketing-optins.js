// ── Marketing opt-in registry helpers ────────────────────────────────────────
// A campaign's gate/opt-in form (e.g. "register to watch" for a YouTube event)
// records who signed up in marketing_optins, keyed by (campaign_id, email). This
// lets us suppress the announcement for that PERSON across devices/browsers — not
// just the one browser that holds a localStorage dismiss. Suppression only kicks
// in when we can identify the current viewer's email (logged-in portal user, a
// GHL sub-account contact, or an embed that supplies the email); anonymous
// website visitors fall back to the per-browser localStorage dismiss as before.
//
// Pure DB helpers here (no GHL calls) so both api/embed.js and api/marketing.js
// can import them cheaply on the hot path. The authoritative GHL backfill
// (syncCampaignOptins) lives in api/marketing.js where the GHL/conversion
// helpers already are.

// Normalize an email to its comparable form (lowercased, trimmed). Returns '' if
// the input isn't a plausible email.
export function normEmail(x) {
    const s = String(x == null ? '' : x).trim().toLowerCase();
    if (!s || s.length > 200) return '';
    // Cheap sanity check — must look like a@b.c
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

// Some embed viewers are identified by an email as their viewer_id (e.g.
// "email:foo@bar.com" or the bare address). Pull an email out of a viewer id.
export function emailFromViewer(viewer) {
    let v = String(viewer || '');
    if (v.indexOf('email:') === 0) v = v.slice(6);
    return normEmail(v);
}

// Record one opt-in (idempotent per campaign+email). Best-effort — never throws.
export async function recordOptin(supabase, campaignId, email, source, contactId) {
    const e = normEmail(email);
    if (!campaignId || !e) return;
    try {
        await supabase.from('marketing_optins').upsert(
            { campaign_id: campaignId, email: e, source: source || null, contact_id: contactId || null },
            { onConflict: 'campaign_id,email', ignoreDuplicates: true }
        );
    } catch (_) { /* best-effort */ }
}

// Bulk record opt-ins from a list of { email, contact_id } (GHL sync). Best-effort.
export async function recordOptins(supabase, campaignId, items, source) {
    if (!campaignId || !Array.isArray(items) || !items.length) return 0;
    const seen = new Set();
    const rows = [];
    items.forEach(it => {
        const e = normEmail(it && it.email);
        if (!e || seen.has(e)) return;
        seen.add(e);
        rows.push({ campaign_id: campaignId, email: e, contact_id: (it && it.contact_id) || null, source: source || 'ghl_sync' });
    });
    if (!rows.length) return 0;
    try {
        await supabase.from('marketing_optins').upsert(rows, { onConflict: 'campaign_id,email', ignoreDuplicates: true });
    } catch (_) { /* best-effort */ }
    return rows.length;
}

// Given a viewer email and a list of candidate campaign ids, return the Set of
// campaign ids the viewer has already opted into (so they can be suppressed).
export async function optedInIds(supabase, email, campaignIds) {
    const e = normEmail(email);
    if (!e || !Array.isArray(campaignIds) || !campaignIds.length) return new Set();
    try {
        const { data } = await supabase.from('marketing_optins')
            .select('campaign_id').eq('email', e).in('campaign_id', campaignIds);
        return new Set((data || []).map(r => r.campaign_id));
    } catch (_) {
        return new Set();
    }
}
