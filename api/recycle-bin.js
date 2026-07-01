import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Recycle bin over the deleted_records archive (tickets + returns).
// super_admin only. Restore re-inserts the snapshot into its original table.
export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    res.setHeader('Content-Type', 'application/json');

    const { data: caller } = await supabase.from('app_users').select('role').eq('userid', session.userid).maybeSingle();
    if (String(caller?.role || '').toLowerCase() !== 'super_admin') {
        return res.status(403).json({ success: false, message: 'Super admin only.' });
    }

    const { action, id } = req.body || {};
    try {
        if (action === 'list') {
            const { data } = await supabase.from('deleted_records')
                .select('id, entity_type, entity_id, label, deleted_by, deleted_at, restored_at')
                .is('restored_at', null)
                .order('deleted_at', { ascending: false }).limit(200);
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'restore') {
            if (!id) return res.status(400).json({ success: false, message: 'id required' });
            const { data: rec } = await supabase.from('deleted_records').select('*').eq('id', id).maybeSingle();
            if (!rec) return res.status(404).json({ success: false, message: 'Archive record not found.' });
            if (rec.restored_at) return res.status(200).json({ success: false, message: 'Already restored.' });

            const snap = { ...(rec.snapshot || {}) };
            if (rec.entity_type === 'return') {
                delete snap.__comments;
                const { error } = await supabase.from('returns').insert(snap);
                if (error) throw new Error('Restore failed: ' + error.message);
            } else if (rec.entity_type === 'ticket') {
                const comments = snap.__comments || [];
                delete snap.__comments;
                const { error } = await supabase.from('support_tickets').insert(snap);
                if (error) throw new Error('Restore failed: ' + error.message);
                if (comments.length) await supabase.from('ticket_comments').insert(comments).then(() => {}).catch(() => {});
            } else {
                return res.status(400).json({ success: false, message: 'Unsupported type: ' + rec.entity_type });
            }

            await supabase.from('deleted_records').update({ restored_at: new Date().toISOString() }).eq('id', id);
            supabase.from('activity_logs').insert({
                email: session.userid, action: `Restored ${rec.entity_type} from recycle bin — ${rec.label || ''}`,
                status: 'success', category: 'admin', target_id: rec.entity_id, target_type: rec.entity_type, severity: 'info'
            }).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true });
        }

        if (action === 'purge') {
            if (!id) return res.status(400).json({ success: false, message: 'id required' });
            const { error } = await supabase.from('deleted_records').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[recycle-bin]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
