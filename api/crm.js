// CRM data API — per-CRM (sub-account) isolated, HighLevel-style.
// Every read/write is scoped to a sub_account_id the caller can access:
//   • must be a member of the owning agency (partner_portals via partner_portal_members)
//   • sub-partners must have that CRM in their granted scope
//   • portal gods pass
// This mirrors get_sub_account in whitelabel.js so access stays consistent.
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
// Returns { sub, portal_id } if the person may use this CRM, else null.
async function subAccess(personId, subId) {
    if (!subId) return null;
    const { data: sub } = await supabase.from('agency_sub_accounts').select('*').eq('id', subId).maybeSingle();
    if (!sub) return null;
    if (await isGod(personId)) return { sub, portal_id: sub.portal_id };
    const { data: mem } = await supabase.from('partner_portal_members').select('*').eq('portal_id', sub.portal_id).eq('person_id', personId).maybeSingle();
    if (!mem) return null;
    if (mem.role === 'sub_partner') {
        const granted = (mem.scope && Array.isArray(mem.scope.sub_account_ids)) ? mem.scope.sub_account_ids : [];
        if (!granted.includes(sub.id)) return null;
    }
    return { sub, portal_id: sub.portal_id };
}

const CONTACT_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'company', 'title', 'source', 'status', 'notes'];

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const body = req.body || {};
    const action = body.action;
    try {
        const personId = await validatePartner(body.token);
        if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

        // Authorize by a contact row's own sub_account_id (for id-based mutations).
        async function contactAccess(contactId) {
            const { data: c } = await supabase.from('crm_contacts').select('*').eq('id', contactId).maybeSingle();
            if (!c) return null;
            const acc = await subAccess(personId, c.sub_account_id);
            if (!acc) return null;
            return { contact: c, portal_id: acc.portal_id };
        }

        // ── CONTACTS ─────────────────────────────────────────────────────────
        if (action === 'list_contacts') {
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data: contacts } = await supabase.from('crm_contacts')
                .select('*').eq('sub_account_id', body.sub_account_id)
                .order('created_at', { ascending: false }).limit(1000);
            let list = contacts || [];
            if (body.q) {
                const q = String(body.q).toLowerCase();
                list = list.filter(c => [c.first_name, c.last_name, c.email, c.phone, c.company].some(v => String(v || '').toLowerCase().includes(q)));
            }
            const ids = list.map(c => c.id);
            const tagMap = {};
            if (ids.length) {
                const { data: links } = await supabase.from('crm_contact_tags').select('contact_id, crm_tags(id,name,color)').in('contact_id', ids);
                (links || []).forEach(l => { if (l.crm_tags) (tagMap[l.contact_id] = tagMap[l.contact_id] || []).push(l.crm_tags); });
            }
            list = list.map(c => ({ ...c, tags: tagMap[c.id] || [] }));
            return res.status(200).json({ success: true, contacts: list });
        }

        if (action === 'create_contact') {
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const f = body.contact || {};
            const row = { sub_account_id: body.sub_account_id, portal_id: acc.portal_id, created_by: personId };
            CONTACT_FIELDS.forEach(k => { row[k] = (f[k] === '' || f[k] === undefined) ? null : f[k]; });
            if (!row.status) row.status = 'active';
            const { data, error } = await supabase.from('crm_contacts').insert(row).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not create contact.' });
            if (Array.isArray(body.tag_ids)) await applyTags(data.id, data.sub_account_id, body.tag_ids);
            return res.status(200).json({ success: true, contact: data });
        }

        if (action === 'update_contact') {
            const ca = await contactAccess(body.id);
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const f = body.contact || {};
            const patch = {};
            CONTACT_FIELDS.forEach(k => { if (k in f) patch[k] = f[k] === '' ? null : f[k]; });
            const { data, error } = await supabase.from('crm_contacts').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update contact.' });
            if (Array.isArray(body.tag_ids)) await applyTags(body.id, ca.contact.sub_account_id, body.tag_ids);
            return res.status(200).json({ success: true, contact: data });
        }

        if (action === 'delete_contact') {
            const ca = await contactAccess(body.id);
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
            const ca = await contactAccess(body.contact_id);
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const applied = await applyTags(body.contact_id, ca.contact.sub_account_id, body.tag_ids || []);
            return res.status(200).json({ success: true, tag_ids: applied });
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
