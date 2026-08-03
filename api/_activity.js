// Shared activity-log writer. Best-effort — never throws, never blocks the caller.
// Mirrors the existing activity_logs shape used across the app.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// logActivity({ email, action, category, status, severity, target_id, target_type,
//               old_value, new_value }, req? )
export function logActivity(fields = {}, req = null) {
    try {
        const row = {
            email: fields.email || null,
            action: fields.action || '',
            status: fields.status || 'success',
            category: fields.category || 'marketing',
            severity: fields.severity || 'info',
            target_id: fields.target_id != null ? String(fields.target_id) : null,
            target_type: fields.target_type || null,
            old_value: fields.old_value ?? null,
            new_value: fields.new_value ?? null
        };
        if (req) {
            row.user_agent = req.headers?.['user-agent'] || null;
            row.ip_address = (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || null;
        }
        // Fire-and-forget.
        supabase.from('activity_logs').insert(row).then(() => {}).catch(() => {});
    } catch { /* swallow — logging must never break the request */ }
}
