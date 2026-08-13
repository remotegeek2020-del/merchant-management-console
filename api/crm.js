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
            if (body.custom && typeof body.custom === 'object') row.custom = body.custom;
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
            if (body.custom && typeof body.custom === 'object') patch.custom = body.custom;
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

        // ── CONTACT RECORD (detail + notes + tasks) ──────────────────────────
        if (action === 'get_contact') {
            const ca = await contactAccess(body.id);
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const cid = body.id;
            const [tagsRes, oppsRes, notesRes, tasksRes] = await Promise.all([
                supabase.from('crm_contact_tags').select('crm_tags(id,name,color)').eq('contact_id', cid),
                supabase.from('crm_opportunities').select('*').eq('contact_id', cid).order('created_at', { ascending: false }),
                supabase.from('crm_notes').select('*').eq('contact_id', cid).order('created_at', { ascending: false }),
                supabase.from('crm_tasks').select('*').eq('contact_id', cid).order('done', { ascending: true }).order('due_date', { ascending: true }).order('created_at', { ascending: false })
            ]);
            const tags = (tagsRes.data || []).map(t => t.crm_tags).filter(Boolean);
            return res.status(200).json({ success: true, contact: { ...ca.contact, tags }, opportunities: oppsRes.data || [], notes: notesRes.data || [], tasks: tasksRes.data || [] });
        }

        if (action === 'add_note') {
            const ca = await contactAccess(body.contact_id);
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
            const ca = await contactAccess(n.contact_id);
            if (!ca) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_notes').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        if (action === 'add_task') {
            const ca = await contactAccess(body.contact_id);
            if (!ca) return res.status(403).json({ success: false, message: 'No access to this contact.' });
            const title = (body.title || '').trim();
            if (!title) return res.status(400).json({ success: false, message: 'Task title required.' });
            const { data, error } = await supabase.from('crm_tasks').insert({ sub_account_id: ca.contact.sub_account_id, portal_id: ca.portal_id, contact_id: body.contact_id, title, due_date: body.due_date || null, created_by: personId }).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not add task.' });
            return res.status(200).json({ success: true, task: data });
        }
        if (action === 'update_task') {
            const { data: t } = await supabase.from('crm_tasks').select('*').eq('id', body.id).maybeSingle();
            if (!t) return res.status(404).json({ success: false, message: 'Task not found.' });
            const acc = await subAccess(personId, t.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            const patch = {};
            if ('title' in body && (body.title || '').trim()) patch.title = body.title.trim();
            if ('due_date' in body) patch.due_date = body.due_date || null;
            if ('done' in body) { patch.done = !!body.done; patch.done_at = body.done ? new Date().toISOString() : null; }
            const { data, error } = await supabase.from('crm_tasks').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update task.' });
            return res.status(200).json({ success: true, task: data });
        }
        if (action === 'delete_task') {
            const { data: t } = await supabase.from('crm_tasks').select('sub_account_id').eq('id', body.id).maybeSingle();
            if (!t) return res.status(404).json({ success: false, message: 'Task not found.' });
            const acc = await subAccess(personId, t.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_tasks').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        // ── OPPORTUNITIES / PIPELINE ─────────────────────────────────────────
        async function oppAccess(oppId) {
            const { data: o } = await supabase.from('crm_opportunities').select('*').eq('id', oppId).maybeSingle();
            if (!o) return null;
            const acc = await subAccess(personId, o.sub_account_id);
            if (!acc) return null;
            return { opp: o, portal_id: acc.portal_id };
        }

        if (action === 'get_pipeline') {
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            // Lazily seed a default pipeline (New/Contacted/.../Won/Lost) on first view.
            const { data: pid } = await supabase.rpc('crm_ensure_default_pipeline', { p_sub: body.sub_account_id });
            const { data: pipeline } = await supabase.from('crm_pipelines').select('*').eq('id', pid).maybeSingle();
            const { data: stages } = await supabase.from('crm_pipeline_stages').select('*').eq('pipeline_id', pid).order('position', { ascending: true });
            return res.status(200).json({ success: true, pipeline, stages: stages || [] });
        }

        if (action === 'list_opportunities') {
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data: opps } = await supabase.from('crm_opportunities')
                .select('*').eq('sub_account_id', body.sub_account_id)
                .order('position', { ascending: true }).order('created_at', { ascending: true }).limit(2000);
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
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const o = body.opp || {};
            const title = (o.title || '').trim();
            if (!title) return res.status(400).json({ success: false, message: 'Deal title required.' });
            const { data: pid } = await supabase.rpc('crm_ensure_default_pipeline', { p_sub: body.sub_account_id });
            let stageId = o.stage_id;
            if (!stageId) { const { data: st } = await supabase.from('crm_pipeline_stages').select('id').eq('pipeline_id', pid).order('position').limit(1); stageId = st && st[0] && st[0].id; }
            // place at the end of its stage
            const { data: last } = await supabase.from('crm_opportunities').select('position').eq('sub_account_id', body.sub_account_id).eq('stage_id', stageId).order('position', { ascending: false }).limit(1);
            const pos = (last && last[0] ? (last[0].position || 0) : 0) + 1;
            const row = {
                sub_account_id: body.sub_account_id, portal_id: acc.portal_id, pipeline_id: pid, stage_id: stageId,
                contact_id: o.contact_id || null, title, value_cents: Math.round(Number(o.value || 0) * 100) || 0,
                status: o.status || 'open', expected_close_date: o.expected_close_date || null, notes: o.notes || null,
                position: pos, created_by: personId
            };
            const { data, error } = await supabase.from('crm_opportunities').insert(row).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not create deal.' });
            return res.status(200).json({ success: true, opportunity: data });
        }

        if (action === 'update_opportunity') {
            const oa = await oppAccess(body.id);
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
            const { data, error } = await supabase.from('crm_opportunities').update(patch).eq('id', body.id).select('*').single();
            if (error) return res.status(500).json({ success: false, message: 'Could not update deal.' });
            return res.status(200).json({ success: true, opportunity: data });
        }

        // Drag a deal to another stage; status follows the stage's won/lost flag.
        if (action === 'move_opportunity') {
            const oa = await oppAccess(body.id);
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
            const oa = await oppAccess(body.id);
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
            const acc = await subAccess(personId, body.sub_account_id);
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
            const acc = await subAccess(personId, fld.sub_account_id);
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
            const acc = await subAccess(personId, fld.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_custom_fields').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
        }

        // ── TAG MANAGEMENT (rename / recolor / delete) ───────────────────────
        if (action === 'update_tag') {
            const { data: tag } = await supabase.from('crm_tags').select('*').eq('id', body.id).maybeSingle();
            if (!tag) return res.status(404).json({ success: false, message: 'Tag not found.' });
            const acc = await subAccess(personId, tag.sub_account_id);
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
            const acc = await subAccess(personId, tag.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_tags').delete().eq('id', body.id); // contact links cascade
            return res.status(200).json({ success: true });
        }

        // ── REPORTING (aggregates from this CRM's own data) ──────────────────
        if (action === 'get_report') {
            const acc = await subAccess(personId, body.sub_account_id);
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
            const acc = await subAccess(personId, body.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access to this CRM.' });
            const { data } = await supabase.from('crm_forms').select('*').eq('sub_account_id', body.sub_account_id).order('created_at', { ascending: false });
            return res.status(200).json({ success: true, forms: data || [] });
        }
        if (action === 'create_form') {
            const acc = await subAccess(personId, body.sub_account_id);
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
            const acc = await subAccess(personId, form.sub_account_id);
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
            const acc = await subAccess(personId, form.sub_account_id);
            if (!acc) return res.status(403).json({ success: false, message: 'No access.' });
            await supabase.from('crm_forms').delete().eq('id', body.id);
            return res.status(200).json({ success: true });
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
