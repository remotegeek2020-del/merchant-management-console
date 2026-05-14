import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function signPayload(secret, payload) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function deliverToUrl(url, secret, event, payload, attempt = 1) {
    const body = JSON.stringify(payload);
    const sig  = signPayload(secret, body);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-PayProTec-Event': event,
                'X-PayProTec-Signature': sig,
                'X-PayProTec-Timestamp': new Date().toISOString(),
                'User-Agent': 'PayProTec-Webhooks/1.0'
            },
            body,
            signal: AbortSignal.timeout(10000) // 10s timeout
        });
        return { status: res.status, success: res.status >= 200 && res.status < 300 };
    } catch (err) {
        return { status: 0, success: false, error: err.message };
    }
}

// ── DELIVER TO ALL PARTNER WEBHOOKS SUBSCRIBED TO THIS EVENT ──
export async function dispatchPartnerEvent(ownerId, event, payload) {
    const { data: endpoints } = await supabase
        .from('webhook_endpoints')
        .select('id, url, secret')
        .eq('owner_id', ownerId)
        .eq('is_active', true)
        .contains('events', [event]);

    if (!endpoints?.length) return;

    for (const ep of endpoints) {
        let result = await deliverToUrl(ep.url, ep.secret, event, payload);

        // Retry up to 2 more times with backoff on failure
        if (!result.success) {
            await new Promise(r => setTimeout(r, 2000));
            result = await deliverToUrl(ep.url, ep.secret, event, payload, 2);
        }
        if (!result.success) {
            await new Promise(r => setTimeout(r, 5000));
            result = await deliverToUrl(ep.url, ep.secret, event, payload, 3);
        }

        // Log delivery
        await supabase.from('webhook_delivery_log').insert({
            webhook_id: ep.id,
            event,
            payload,
            status_code: result.status,
            success: result.success,
            error_message: result.error || null,
            attempts: result.success ? 1 : 3
        });

        // Update last_triggered_at and last_status on the endpoint
        await supabase.from('webhook_endpoints').update({
            last_triggered_at: new Date().toISOString(),
            last_status: result.status
        }).eq('id', ep.id);
    }
}

// ── DELIVER TO ALL ENABLED STAFF INTEGRATIONS ─────────────────
export async function dispatchStaffEvent(event, payload) {
    const { data: integrations } = await supabase
        .from('integrations')
        .select('id, type, config, events')
        .eq('is_enabled', true)
        .contains('events', [event]);

    if (!integrations?.length) return;

    for (const integration of integrations) {
        let result = { status: 0, success: false };

        if (integration.type === 'slack') {
            result = await deliverSlack(integration.config, event, payload);
        } else if (integration.type === 'zapier' || integration.type === 'webhook') {
            const url = integration.config.webhook_url;
            if (!url) continue;
            result = await deliverToUrl(url, integration.config.secret || 'paypro', event, payload);
        }

        await supabase.from('integrations').update({
            last_triggered_at: new Date().toISOString(),
            last_status: result.status
        }).eq('id', integration.id);
    }
}

async function deliverSlack(config, event, payload) {
    const url = config.webhook_url;
    if (!url) return { status: 0, success: false, error: 'No webhook URL configured' };

    const text = formatSlackMessage(event, payload);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
            signal: AbortSignal.timeout(8000)
        });
        return { status: res.status, success: res.ok };
    } catch (err) {
        return { status: 0, success: false, error: err.message };
    }
}

function formatSlackMessage(event, payload) {
    const d = payload.data || payload;
    switch (event) {
        case 'ticket.created':
            return `🎫 *New Ticket* — ${d.ticket_number || ''}\n*Subject:* ${d.subject}\n*Partner:* ${d.partner_name || 'Unknown'}\n*Priority:* ${d.priority}`;
        case 'ticket.updated':
            return `🔄 *Ticket Updated* — ${d.ticket_number || ''}\n*Change:* ${d.change || 'Status updated'}\n*Partner:* ${d.partner_name || 'Unknown'}`;
        case 'ticket.comment_added':
            return `💬 *New Comment* on ${d.ticket_number || 'ticket'}\n*From:* ${d.author_name}\n*Message:* ${(d.body || '').slice(0, 200)}`;
        case 'merchant.status_changed':
            return `🏪 *Merchant Status Changed* — ${d.dba_name || 'Merchant'}\n*${d.old_status} → ${d.new_status}*\n*Partner:* ${d.partner_name || 'Unknown'}`;
        default:
            return `📡 *PayProTec Event:* \`${event}\`\n${JSON.stringify(d, null, 2).slice(0, 500)}`;
    }
}

// ── COMBINED DISPATCHER (called from API handlers) ────────────
export async function dispatchEvent(ownerId, event, payload) {
    // Fire both in parallel — don't await (serverless safe fire-and-forget with internal awaits)
    dispatchPartnerEvent(ownerId, event, payload).catch(() => {});
    dispatchStaffEvent(event, payload).catch(() => {});
}
