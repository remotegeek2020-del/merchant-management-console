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

    // ── BACKFILL EXISTING PRIME49 MERCHANTS (preview + run) ──────────────────
    // The live automation only fires on new uploads / prime49 flips. This catches
    // up merchants that were already Prime49 before it was enabled. Deduped
    // against existing prime49_auto tasks, so it's safe to run repeatedly.
    if (action === 'backfill_preview' || action === 'backfill_run') {
        try {
            const { data: cfg } = await supabase
                .from('prime49_task_automation_config').select('*').eq('id', 1).maybeSingle();

            // Agent-level Prime49 — the merchant's OWN agent ID must be flagged
            // prime49 (matches the live automation and what staff verify per
            // merchant). Optional enrollment-date range — default covers 2026;
            // clear `start_date` to reach back to the very first Prime49 merchant.
            const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
            const startDate = (req.body.start_date === '' || isDate(req.body.start_date)) ? req.body.start_date
                            : '2026-01-01';   // undefined/invalid → default to the report window
            const endDate   = isDate(req.body.end_date) ? req.body.end_date : null;
            const IN_CHUNK = 200;

            const { data: p49Ids } = await supabase
                .from('agent_identifiers').select('id_string').eq('prime49', true).limit(10000);
            const idStrings = [...new Set((p49Ids || []).map(r => r.id_string).filter(Boolean))];
            if (!idStrings.length) return res.json({ success: true, data: { prime49_merchants: 0, already_have_task: 0, to_create: 0 } });

            // Every merchant on those agent IDs, within the chosen enrollment range.
            let mRows = [];
            for (let i = 0; i < idStrings.length; i += IN_CHUNK) {
                let q = supabase
                    .from('merchants')
                    .select('id, merchant_id, dba_name, agent_id, agent_name, enrollment_date, account_status')
                    .in('agent_id', idStrings.slice(i, i + IN_CHUNK));
                if (startDate) q = q.gte('enrollment_date', startDate);
                if (endDate)   q = q.lte('enrollment_date', endDate + 'T23:59:59');
                const { data } = await q.limit(10000);
                if (data) mRows = mRows.concat(data);
            }
            if (!mRows.length) return res.json({ success: true, data: { prime49_merchants: 0, already_have_task: 0, to_create: 0 } });

            // Merchants that already have a prime49_auto task (dedup set).
            const { data: existing } = await supabase
                .from('merchant_tasks').select('merchant_id').eq('source', 'prime49_auto').limit(100000);
            const haveTask = new Set((existing || []).map(r => r.merchant_id));

            const eligible = mRows.filter(m => !haveTask.has(m.id));

            // Resolve assignee name for the message.
            let assigneeName = null;
            if (cfg?.assignee_id) {
                const { data: a } = await supabase.from('app_users').select('first_name, last_name').eq('userid', cfg.assignee_id).maybeSingle();
                if (a) assigneeName = `${a.first_name || ''} ${a.last_name || ''}`.trim();
            }

            if (action === 'backfill_preview') {
                return res.json({ success: true, data: {
                    prime49_merchants: mRows.length,
                    already_have_task: mRows.length - eligible.length,
                    to_create: eligible.length,
                    assignee_id: cfg?.assignee_id || null,
                    assignee_name: assigneeName,
                    start_date: startDate || null,
                    end_date: endDate || null
                }});
            }

            // ── RUN ──
            if (!eligible.length) return res.json({ success: true, data: { created: 0, skipped: mRows.length } });

            const title = cfg?.task_title_template || 'New Prime49 Merchant: {{dba_name}}';
            const desc  = cfg?.task_description_template || '';
            const tpl = (t, m) => (t || '')
                .replace(/\{\{dba_name\}\}/gi,        m.dba_name        || '—')
                .replace(/\{\{mid\}\}/gi,             m.merchant_id     || '—')
                .replace(/\{\{agent_id\}\}/gi,        m.agent_id        || '—')
                .replace(/\{\{partner_name\}\}/gi,    m.agent_name      || '—')
                .replace(/\{\{enrollment_date\}\}/gi, m.enrollment_date || '—')
                .replace(/\{\{account_status\}\}/gi,  m.account_status  || '—');

            const tasks = eligible.map(m => ({
                title:       tpl(title, m),
                body:        tpl(desc, m),
                priority:    cfg?.priority || 'Normal',
                status:      'Pending',
                merchant_id: m.id,
                assigned_to: cfg?.assignee_id || null,
                created_by:  session.userid,
                source:      'prime49_auto'
            }));

            let created = 0;
            const CHUNK = 500;
            for (let i = 0; i < tasks.length; i += CHUNK) {
                const { error: tErr, count } = await supabase
                    .from('merchant_tasks').insert(tasks.slice(i, i + CHUNK), { count: 'exact' });
                if (tErr) return res.json({ success: false, message: tErr.message, data: { created } });
                created += (count ?? tasks.slice(i, i + CHUNK).length);
            }

            await supabase.from('activity_logs').insert({
                email: session.userid, action: `Prime49 backfill: created ${created} catch-up task(s)`,
                status: 'success', category: 'merchants', target_type: 'task', severity: 'info',
                new_value: { created, assignee: cfg?.assignee_id || null }
            });

            return res.json({ success: true, data: { created, skipped: mRows.length - eligible.length } });
        } catch (e) {
            return res.json({ success: false, message: e.message });
        }
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
}
