import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

async function isSuperAdmin(supabase, userid) {
    if (!userid) return false;
    const { data } = await supabase.from('app_users').select('role, is_active').eq('userid', userid).single();
    return data?.is_active === true && data?.role === 'super_admin';
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const body = req.body || {};

    // get_all is public — needed by login page and partner portal for branding
    if (body.action !== 'get_all') {
        const session = await validateSession(req);
        if (!session) return sessionErrorResponse(res);
    }

    try {
        // Public — flat key/value for the site loader
        if (body.action === 'get_all') {
            const { data, error } = await supabase.from('site_settings').select('key, value');
            if (error) throw error;
            const settings = {};
            (data || []).forEach(r => { settings[r.key] = r.value; });
            return res.status(200).json({ success: true, settings });
        }

        // Admin — full rows with labels + categories for the CMS UI
        if (body.action === 'get_for_cms') {
            if (!(await isSuperAdmin(supabase, body.userid))) return res.status(403).json({ success: false, message: 'Access denied.' });
            const { data, error } = await supabase
                .from('site_settings').select('*').order('category').order('key');
            if (error) throw error;
            return res.status(200).json({ success: true, rows: data || [] });
        }

        // Admin — save multiple keys at once
        if (body.action === 'bulk_update') {
            if (!(await isSuperAdmin(supabase, body.userid))) return res.status(403).json({ success: false, message: 'Access denied.' });
            const { updates } = body;
            if (!updates || typeof updates !== 'object') return res.status(400).json({ success: false, message: 'Updates required.' });
            const now = new Date().toISOString();
            for (const [key, value] of Object.entries(updates)) {
                const { error } = await supabase.from('site_settings')
                    .update({ value: value ?? '', updated_at: now, updated_by: body.userid })
                    .eq('key', key);
                if (error) throw error;
            }
            return res.status(200).json({ success: true });
        }

        // Admin — upload an image to cms-assets bucket, return public URL
        if (body.action === 'upload_asset') {
            if (!(await isSuperAdmin(supabase, body.userid))) return res.status(403).json({ success: false, message: 'Access denied.' });
            const { filename, data: b64, contentType } = body;
            if (!filename || !b64 || !contentType) return res.status(400).json({ success: false, message: 'filename, data, and contentType are required.' });
            const buffer = Buffer.from(b64, 'base64');
            const ext = filename.split('.').pop().toLowerCase();
            const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
            const { error: upErr } = await supabase.storage.from('cms-assets').upload(safeName, buffer, {
                contentType,
                upsert: false,
            });
            if (upErr) throw upErr;
            const { data: urlData } = supabase.storage.from('cms-assets').getPublicUrl(safeName);
            return res.status(200).json({ success: true, url: urlData.publicUrl });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
