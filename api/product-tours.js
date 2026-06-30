import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

// Reusable product-tour system (Intercom-style).
// Reads (list_active / list / get): any authenticated staff member.
// Writes (save / toggle / bump_version / delete): super_admin only.
export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const body = req.body || {};
    const action = body.action || (req.method === 'GET' ? 'list_active' : null);

    // Resolve the caller (for super_admin gating + audit trail)
    let _caller = null;
    const caller = async () => {
        if (_caller) return _caller;
        const { data } = await supabase.from('app_users')
            .select('role, is_active, first_name, last_name, email').eq('userid', session.userid).maybeSingle();
        _caller = data || {};
        return _caller;
    };
    const requireSuperAdmin = async () => {
        const c = await caller();
        if (!c?.is_active || c.role !== 'super_admin') return false;
        return true;
    };
    const callerName = (c) => `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.email || session.userid;

    const slugify = (s) => String(s || '').toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tour';

    try {
        // ── LIST ACTIVE — only enabled tours for one page (runtime, lightweight) ──
        if (action === 'list_active') {
            const page = body.page || req.query?.page;
            if (!page) return res.status(400).json({ success: false, message: 'page required' });
            const { data } = await supabase.from('product_tours')
                .select('id, tour_key, name, page, version, steps')
                .eq('page', page).eq('enabled', true);
            return res.status(200).json({ success: true, tours: data || [] });
        }

        // ── LIST — all tours (editor) ──
        if (action === 'list') {
            const { data } = await supabase.from('product_tours')
                .select('*').order('updated_at', { ascending: false });
            return res.status(200).json({ success: true, tours: data || [] });
        }

        // ── GET one tour ──
        if (action === 'get') {
            const { id, tour_key } = body;
            let q = supabase.from('product_tours').select('*');
            q = id ? q.eq('id', id) : q.eq('tour_key', tour_key);
            const { data } = await q.maybeSingle();
            if (!data) return res.status(404).json({ success: false, message: 'Tour not found.' });
            return res.status(200).json({ success: true, tour: data });
        }

        // ── SAVE (create or update) ──
        if (action === 'save') {
            if (!(await requireSuperAdmin())) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const c = await caller();
            const t = body.tour || {};
            if (!t.name || !t.page) return res.status(400).json({ success: false, message: 'name and page are required.' });

            const steps = Array.isArray(t.steps) ? t.steps.map(s => ({
                selector: String(s.selector || '').trim(),
                title: String(s.title || '').slice(0, 200),
                body: String(s.body || '').slice(0, 2000),
                position: ['top', 'bottom', 'left', 'right', 'over'].includes(s.position) ? s.position : 'auto'
            })) : [];

            const row = {
                name: String(t.name).slice(0, 120),
                page: String(t.page).slice(0, 200),
                description: t.description ? String(t.description).slice(0, 500) : null,
                steps,
                updated_at: new Date().toISOString()
            };

            let result;
            if (t.id) {
                const { data, error } = await supabase.from('product_tours')
                    .update(row).eq('id', t.id).select('*').single();
                if (error) throw error;
                result = data;
            } else {
                // New tour — generate a unique key from the name
                let baseKey = slugify(t.tour_key || t.name);
                let key = baseKey, n = 1;
                while (true) {
                    const { data: clash } = await supabase.from('product_tours').select('id').eq('tour_key', key).maybeSingle();
                    if (!clash) break;
                    key = `${baseKey}-${++n}`;
                }
                row.tour_key = key;
                row.created_by = callerName(c);
                row.enabled = false;
                row.version = 1;
                const { data, error } = await supabase.from('product_tours').insert(row).select('*').single();
                if (error) throw error;
                result = data;
            }

            supabase.from('activity_logs').insert({
                email: c.email || session.userid,
                action: `Product tour saved by ${callerName(c)} — ${result.name}`,
                status: 'success', category: 'admin', target_id: result.id, target_type: 'product_tour', severity: 'info'
            }).then(() => {}).catch(() => {});

            return res.status(200).json({ success: true, tour: result });
        }

        // ── TOGGLE enabled. Enabling bumps version so it re-shows to everyone. ──
        if (action === 'toggle') {
            if (!(await requireSuperAdmin())) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const c = await caller();
            const { id, enabled } = body;
            if (!id) return res.status(400).json({ success: false, message: 'id required' });
            const on = !!enabled;
            const { data: cur } = await supabase.from('product_tours').select('version').eq('id', id).maybeSingle();
            const patch = { enabled: on, updated_at: new Date().toISOString() };
            if (on) patch.version = (cur?.version || 1) + 1; // re-show to all when (re)enabled
            const { data, error } = await supabase.from('product_tours').update(patch).eq('id', id).select('*').single();
            if (error) throw error;

            supabase.from('activity_logs').insert({
                email: c.email || session.userid,
                action: `Product tour ${on ? 'enabled' : 'disabled'} by ${callerName(c)} — ${data.name}`,
                status: 'success', category: 'admin', target_id: id, target_type: 'product_tour', severity: 'info'
            }).then(() => {}).catch(() => {});

            return res.status(200).json({ success: true, tour: data });
        }

        // ── BUMP VERSION (re-show an already-enabled tour to everyone) ──
        if (action === 'bump_version') {
            if (!(await requireSuperAdmin())) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const { id } = body;
            if (!id) return res.status(400).json({ success: false, message: 'id required' });
            const { data: cur } = await supabase.from('product_tours').select('version').eq('id', id).maybeSingle();
            const { data, error } = await supabase.from('product_tours')
                .update({ version: (cur?.version || 1) + 1, updated_at: new Date().toISOString() })
                .eq('id', id).select('*').single();
            if (error) throw error;
            return res.status(200).json({ success: true, tour: data });
        }

        // ── DELETE ──
        if (action === 'delete') {
            if (!(await requireSuperAdmin())) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const c = await caller();
            const { id } = body;
            if (!id) return res.status(400).json({ success: false, message: 'id required' });
            const { error } = await supabase.from('product_tours').delete().eq('id', id);
            if (error) throw error;
            supabase.from('activity_logs').insert({
                email: c.email || session.userid,
                action: `Product tour deleted by ${callerName(c)}`,
                status: 'success', category: 'admin', target_id: id, target_type: 'product_tour', severity: 'warning'
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[product-tours]', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred.' });
    }
}
