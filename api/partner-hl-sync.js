// ── PARTNER → HIGHLEVEL SMART-LIST SYNC ──────────────────────────────────────
// Portal-defined partner segments (e.g. "has a Prime49 ID") are pushed to
// HighLevel as a TAG. In HL you build a Smart List filtered by that tag; this
// keeps the tag current (adds it to matches, removes it from non-matches) on a
// schedule or on demand. Staff-gated. Shared runAllSyncs() is used by the cron.
import { createClient } from '@supabase/supabase-js';
import { validateSession as validateStaff, sessionErrorResponse } from './_validate.js';
import { ghlAddContactTags, ghlRemoveContactTags, ghlSearchContactsByTag } from './_ghl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ok = (res, data = {}) => res.status(200).json({ success: true, ...data });
const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });

export const CRITERIA = {
    prime49: 'Partners with a Prime49 ID',
    prime49_no_merchant: 'Prime49 partners with no merchant yet',
    branded: 'Branded partners',
    all_partners: 'All partners (with a HighLevel contact)'
};

async function resolveTargets(criteria) {
    const { data } = await supabase.rpc('partner_hl_sync_targets', { p_criteria: criteria });
    // De-dupe by hl_contact_id.
    const map = new Map();
    (data || []).forEach(r => { if (r.hl_contact_id) map.set(String(r.hl_contact_id), r); });
    return [...map.values()];
}

// Run one sync: apply the tag to all matches; optionally remove it from contacts
// that carry the tag but no longer match. Best-effort; returns counts.
export async function runOneSync(sync) {
    const tag = String(sync.tag || '').trim();
    if (!tag) return { matched: 0, tagged: 0, untagged: 0, error: 'no tag' };
    const loc = sync.hl_location_id || '';   // '' → default configured location
    const targets = await resolveTargets(sync.criteria);
    const targetIds = new Set(targets.map(t => String(t.hl_contact_id)));

    let tagged = 0;
    for (const t of targets.slice(0, 3000)) {
        const r = await ghlAddContactTags(loc, t.hl_contact_id, [tag]);
        if (r.ok) tagged++;
    }

    let untagged = 0;
    if (sync.remove_stale) {
        try {
            const found = await ghlSearchContactsByTag(loc, tag, 2000);
            const have = (found.contacts || []);
            for (const c of have) {
                if (c.id && !targetIds.has(String(c.id))) {
                    const r = await ghlRemoveContactTags(loc, c.id, [tag]);
                    if (r.ok) untagged++;
                }
            }
        } catch (_) { /* best-effort */ }
    }

    const patch = {
        last_run_at: new Date().toISOString(), last_matched: targets.length,
        last_tagged: tagged, last_untagged: untagged, last_error: null
    };
    await supabase.from('partner_hl_syncs').update(patch).eq('id', sync.id);
    return { matched: targets.length, tagged, untagged, error: null };
}

// Run every enabled sync (used by the cron).
export async function runAllSyncs() {
    const { data: syncs } = await supabase.from('partner_hl_syncs').select('*').eq('enabled', true);
    const results = [];
    for (const s of (syncs || [])) {
        try { results.push({ id: s.id, name: s.name, ...(await runOneSync(s)) }); }
        catch (e) {
            await supabase.from('partner_hl_syncs').update({ last_run_at: new Date().toISOString(), last_error: e.message }).eq('id', s.id);
            results.push({ id: s.id, name: s.name, error: e.message });
        }
    }
    return results;
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
    const session = await validateStaff(req);
    if (!session) return sessionErrorResponse(res);
    const { data: caller } = await supabase.from('app_users')
        .select('role, access_marketing').eq('userid', session.userid).maybeSingle();
    const canAccess = !!caller && (caller.role === 'super_admin' || caller.role === 'admin' || caller.access_marketing === true);
    if (!canAccess) return bad(res, 'Access denied.', 403);

    const action = req.body?.action;
    try {
        if (action === 'list_syncs') {
            const { data } = await supabase.from('partner_hl_syncs').select('*').order('created_at', { ascending: false });
            return ok(res, { syncs: data || [], criteria: CRITERIA });
        }
        if (action === 'criteria_count') {
            const targets = await resolveTargets(req.body.criteria || 'prime49');
            return ok(res, { count: targets.length });
        }
        if (action === 'save_sync') {
            const b = req.body;
            const row = {
                name: String(b.name || '').trim() || 'Untitled list',
                criteria: CRITERIA[b.criteria] ? b.criteria : 'prime49',
                hl_location_id: String(b.hl_location_id || '').trim() || null,
                tag: String(b.tag || '').trim(),
                remove_stale: b.remove_stale !== false,
                enabled: b.enabled !== false
            };
            if (!row.tag) return bad(res, 'A HighLevel tag is required.');
            if (b.id) {
                const { error } = await supabase.from('partner_hl_syncs').update(row).eq('id', b.id);
                if (error) throw error;
                return ok(res, { id: b.id });
            }
            row.created_by = String(session.userid);
            const { data, error } = await supabase.from('partner_hl_syncs').insert(row).select('id').single();
            if (error) throw error;
            return ok(res, { id: data.id });
        }
        if (action === 'delete_sync') {
            if (!req.body.id) return bad(res, 'id required');
            const { error } = await supabase.from('partner_hl_syncs').delete().eq('id', req.body.id);
            if (error) throw error;
            return ok(res);
        }
        if (action === 'run_sync') {
            const { data: sync } = await supabase.from('partner_hl_syncs').select('*').eq('id', req.body.id).maybeSingle();
            if (!sync) return bad(res, 'Sync not found.');
            const r = await runOneSync(sync);
            return ok(res, r);
        }
        return bad(res, 'Unknown action');
    } catch (err) {
        console.error('Partner HL Sync Error:', err.message);
        return bad(res, err.message, 500);
    }
}
