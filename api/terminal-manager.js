import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    const { action } = req.body;

    // ── GET VENDORS ──────────────────────────────────────────────────────────
    if (action === 'get_vendors') {
        const { data, error } = await supabase
            .from('vendors')
            .select('id, name, created_at')
            .order('name');
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true, data: data || [] });
    }

    // ── ADD VENDOR ───────────────────────────────────────────────────────────
    if (action === 'add_vendor') {
        const { name } = req.body;
        if (!name?.trim()) return res.json({ success: false, message: 'Vendor name required' });
        const { data, error } = await supabase
            .from('vendors')
            .insert({ name: name.trim() })
            .select('id, name')
            .single();
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true, data });
    }

    // ── UPDATE VENDOR ────────────────────────────────────────────────────────
    if (action === 'update_vendor') {
        const { id, name } = req.body;
        if (!id || !name?.trim()) return res.json({ success: false, message: 'ID and name required' });
        const { error } = await supabase
            .from('vendors')
            .update({ name: name.trim() })
            .eq('id', id);
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true });
    }

    // ── DELETE VENDOR ────────────────────────────────────────────────────────
    if (action === 'delete_vendor') {
        const { id } = req.body;
        if (!id) return res.json({ success: false, message: 'ID required' });
        const { error } = await supabase
            .from('vendors')
            .delete()
            .eq('id', id);
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true });
    }

    // ── GET TERMINAL TYPES (with vendor join) ────────────────────────────────
    if (action === 'get_terminal_types') {
        const { data, error } = await supabase
            .from('terminal_types')
            .select('id, name, vendor_id, vendors(id, name), sort_order, is_active')
            .order('name');
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true, data: data || [] });
    }

    // ── UPSERT TERMINAL TYPE (set/clear vendor) ──────────────────────────────
    if (action === 'upsert_terminal_type') {
        const { name, vendor_id } = req.body;
        if (!name?.trim()) return res.json({ success: false, message: 'Name required' });
        const { error } = await supabase
            .from('terminal_types')
            .upsert({ name: name.trim(), vendor_id: vendor_id || null }, { onConflict: 'name' });
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true });
    }

    // ── BULK SET VENDOR ON TERMINAL TYPES ────────────────────────────────────
    if (action === 'set_vendor_for_types') {
        const { type_ids, vendor_id } = req.body;
        if (!Array.isArray(type_ids) || !type_ids.length) return res.json({ success: false, message: 'type_ids array required' });
        const { error } = await supabase
            .from('terminal_types')
            .update({ vendor_id: vendor_id || null })
            .in('id', type_ids);
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true });
    }

    // ── DELETE TERMINAL TYPE ─────────────────────────────────────────────────
    if (action === 'delete_terminal_type') {
        const { id } = req.body;
        if (!id) return res.json({ success: false, message: 'ID required' });
        const { error } = await supabase
            .from('terminal_types')
            .delete()
            .eq('id', id);
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true });
    }

    // ── GET VENDOR MAP (for client-side joins) ───────────────────────────────
    if (action === 'get_vendor_map') {
        const { data, error } = await supabase
            .from('terminal_types')
            .select('name, vendor_id, vendors(name)')
            .order('name');
        if (error) return res.json({ success: false, message: error.message });
        const map = {};
        (data || []).forEach(t => {
            map[t.name] = t.vendors?.name || null;
        });
        return res.json({ success: true, data: map });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
}
