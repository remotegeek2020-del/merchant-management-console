import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    const { action } = req.body;

    // ── GET CONFIG ───────────────────────────────────────────────────────────
    if (action === 'get_config') {
        const { data, error } = await supabase
            .from('prime49_task_automation_config')
            .select('*')
            .eq('id', 1)
            .maybeSingle();
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true, data: data || {} });
    }

    // ── SAVE CONFIG ──────────────────────────────────────────────────────────
    if (action === 'save_config') {
        const { enabled, assignee_id, task_title_template, task_description_template, priority } = req.body;
        const { error } = await supabase
            .from('prime49_task_automation_config')
            .upsert({
                id: 1,
                enabled: !!enabled,
                assignee_id: assignee_id || null,
                task_title_template: task_title_template || 'New Prime49 Merchant: {{dba_name}}',
                task_description_template: task_description_template || '',
                priority: priority || 'Normal',
                updated_at: new Date().toISOString(),
                updated_by: session.userid
            }, { onConflict: 'id' });
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true });
    }

    // ── GET STAFF LIST ───────────────────────────────────────────────────────
    if (action === 'get_staff') {
        const { data, error } = await supabase
            .from('app_users')
            .select('userid, first_name, last_name')
            .eq('is_active', true)
            .order('first_name');
        if (error) return res.json({ success: false, message: error.message });
        const staff = (data || []).map(u => ({
            id: u.userid,
            full_name: `${u.first_name || ''} ${u.last_name || ''}`.trim()
        }));
        return res.json({ success: true, data: staff });
    }

    // ── GET RECENT AUTO-CREATED TASKS ────────────────────────────────────────
    if (action === 'get_recent_tasks') {
        const { data, error } = await supabase
            .from('merchant_tasks')
            .select(`
                id, title, status, priority, created_at, assigned_to,
                merchants ( merchant_id, dba_name )
            `)
            .eq('source', 'prime49_auto')
            .order('created_at', { ascending: false })
            .limit(15);
        if (error) return res.json({ success: false, message: error.message });
        return res.json({ success: true, data: data || [] });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
}
