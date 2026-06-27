import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

// Lightweight, non-secret global settings (feature flags etc.).
// GET/read: any authenticated staff member. set: super_admin only.
export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const body = req.body || {};
    const action = body.action || (req.method === 'GET' ? 'get' : null);

    try {
        // ── GET a single key or all settings ────────────────────────────────
        if (action === 'get') {
            const key = body.key || req.query?.key;
            if (key) {
                const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
                return res.status(200).json({ success: true, key, value: data?.value ?? null });
            }
            const { data } = await supabase.from('app_settings').select('key, value');
            const map = Object.fromEntries((data || []).map(r => [r.key, r.value]));
            return res.status(200).json({ success: true, settings: map });
        }

        // ── SET a key (super_admin only) ────────────────────────────────────
        if (action === 'set') {
            const { data: caller } = await supabase.from('app_users')
                .select('role, is_active, first_name, last_name, email').eq('userid', session.userid).maybeSingle();
            if (!caller?.is_active || caller.role !== 'super_admin') {
                return res.status(403).json({ success: false, message: 'Super admin only.' });
            }
            const { key, value } = body;
            if (!key) return res.status(400).json({ success: false, message: 'key required' });

            const actorName = `${caller.first_name || ''} ${caller.last_name || ''}`.trim() || caller.email;
            const { error } = await supabase.from('app_settings').upsert({
                key, value: String(value), updated_at: new Date().toISOString(), updated_by: actorName
            }, { onConflict: 'key' });
            if (error) throw error;

            supabase.from('activity_logs').insert({
                email: caller.email || session.userid,
                action: `Global setting changed by ${actorName} — ${key} = ${value}`,
                status: 'success', category: 'admin', target_id: key, target_type: 'app_setting', severity: 'info',
                new_value: { key, value }
            }).then(() => {}).catch(() => {});

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[app-settings]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
}
