import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import crypto from 'crypto';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function signPayload(secret, body) {
    return 'sha256=' + crypto.createHmac('sha256', secret || '').update(body).digest('hex');
}

// Webhook delivery health + manual retry. super_admin only.
export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    res.setHeader('Content-Type', 'application/json');
    const { data: caller } = await supabase.from('app_users').select('role').eq('userid', session.userid).maybeSingle();
    if (String(caller?.role || '').toLowerCase() !== 'super_admin') {
        return res.status(403).json({ success: false, message: 'Super admin only.' });
    }

    const { action, log_id } = req.body || {};
    try {
        if (action === 'list') {
            const { data: logs } = await supabase.from('webhook_delivery_log')
                .select('id, webhook_id, event, status_code, attempts, success, error_message, created_at')
                .order('created_at', { ascending: false }).limit(100);
            const ids = [...new Set((logs || []).map(l => l.webhook_id).filter(Boolean))];
            let epMap = {};
            if (ids.length) {
                const { data: eps } = await supabase.from('webhook_endpoints').select('id, label, url, is_active').in('id', ids);
                (eps || []).forEach(e => { epMap[e.id] = e; });
            }
            const since = new Date(Date.now() - 24 * 36e5).toISOString();
            const recent = (logs || []).filter(l => l.created_at > since);
            const summary = {
                last24_total: recent.length,
                last24_failed: recent.filter(l => !l.success).length
            };
            const rows = (logs || []).map(l => ({
                ...l,
                endpoint_label: epMap[l.webhook_id]?.label || null,
                endpoint_url: epMap[l.webhook_id]?.url || null,
                endpoint_active: epMap[l.webhook_id]?.is_active
            }));
            return res.status(200).json({ success: true, data: rows, summary });
        }

        if (action === 'retry') {
            if (!log_id) return res.status(400).json({ success: false, message: 'log_id required' });
            const { data: log } = await supabase.from('webhook_delivery_log').select('*').eq('id', log_id).maybeSingle();
            if (!log) return res.status(404).json({ success: false, message: 'Log not found.' });
            const { data: ep } = await supabase.from('webhook_endpoints').select('*').eq('id', log.webhook_id).maybeSingle();
            if (!ep) return res.status(404).json({ success: false, message: 'Endpoint no longer exists.' });

            const body = JSON.stringify(log.payload || {});
            let status = 0, ok = false, errMsg = null;
            try {
                const r = await fetch(ep.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-PayProTec-Event': log.event || 'retry',
                        'X-PayProTec-Signature': signPayload(ep.secret, body),
                        'X-PayProTec-Timestamp': new Date().toISOString(),
                        'User-Agent': 'PayProTec-Webhooks/1.0 (retry)'
                    },
                    body,
                    signal: AbortSignal.timeout(10000)
                });
                status = r.status; ok = r.status >= 200 && r.status < 300;
            } catch (e) { errMsg = e.message; }

            await supabase.from('webhook_delivery_log').insert({
                webhook_id: log.webhook_id, event: log.event, payload: log.payload,
                status_code: status, attempts: 1, success: ok, error_message: errMsg
            });
            await supabase.from('webhook_endpoints').update({ last_triggered_at: new Date().toISOString(), last_status: status || null }).eq('id', ep.id);
            return res.status(200).json({ success: true, delivered: ok, status });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[webhook-health]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
