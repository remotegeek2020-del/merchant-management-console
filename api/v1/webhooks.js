import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { validateApiKey } from './_auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const VALID_EVENTS = ['ticket.created', 'ticket.updated', 'ticket.comment_added', 'merchant.status_changed'];

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    const ctx = await validateApiKey(req, res);
    if (!ctx) return;

    // ── GET: list webhooks + recent delivery log ───────────────
    if (req.method === 'GET') {
        const { data: endpoints } = await supabase
            .from('webhook_endpoints')
            .select('id, label, url, events, is_active, last_triggered_at, last_status, created_at')
            .eq('owner_id', ctx.owner_id)
            .order('created_at', { ascending: false });

        // Recent deliveries (last 20 across all endpoints)
        const ids = (endpoints || []).map(e => e.id);
        let deliveries = [];
        if (ids.length) {
            const { data } = await supabase
                .from('webhook_delivery_log')
                .select('id, webhook_id, event, status_code, success, attempts, created_at')
                .in('webhook_id', ids)
                .order('created_at', { ascending: false })
                .limit(20);
            deliveries = data || [];
        }

        return res.json({ success: true, data: { endpoints: endpoints || [], deliveries } });
    }

    if (req.method !== 'POST') return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET to list or POST to manage.' } });

    const { action, webhook_id, label, url, events } = req.body || {};

    // CREATE
    if (action === 'create') {
        if (!url?.trim()) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'url is required.' } });
        if (!events?.length) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'At least one event is required.' } });

        const invalid = events.filter(e => !VALID_EVENTS.includes(e));
        if (invalid.length) return res.status(400).json({ success: false, error: { code: 'INVALID_EVENT', message: `Unknown events: ${invalid.join(', ')}. Valid: ${VALID_EVENTS.join(', ')}` } });

        // Enforce max 5 webhooks per partner
        const { count } = await supabase.from('webhook_endpoints').select('id', { count: 'exact', head: true }).eq('owner_id', ctx.owner_id).eq('is_active', true);
        if (count >= 5) return res.status(400).json({ success: false, error: { code: 'LIMIT_REACHED', message: 'Maximum 5 active webhooks allowed.' } });

        const secret = crypto.randomBytes(24).toString('hex');
        const { data, error } = await supabase.from('webhook_endpoints').insert({
            owner_id: ctx.owner_id,
            label: (label || 'My Webhook').trim().slice(0, 60),
            url: url.trim(),
            secret,
            events
        }).select('id, label, url, events, is_active, created_at').single();

        if (error) return res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });

        // Return secret only once — used to verify incoming webhook signatures
        return res.status(201).json({ success: true, data: { ...data, secret, secret_note: 'Store this secret securely. It will not be shown again.' } });
    }

    // UPDATE (change label, url, events)
    if (action === 'update') {
        if (!webhook_id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'webhook_id required.' } });
        const { data: ep } = await supabase.from('webhook_endpoints').select('id').eq('id', webhook_id).eq('owner_id', ctx.owner_id).single();
        if (!ep) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Webhook not found or not yours.' } });

        const updates = {};
        if (label) updates.label = label.trim().slice(0, 60);
        if (url)   updates.url   = url.trim();
        if (events) {
            const invalid = events.filter(e => !VALID_EVENTS.includes(e));
            if (invalid.length) return res.status(400).json({ success: false, error: { code: 'INVALID_EVENT', message: `Unknown events: ${invalid.join(', ')}` } });
            updates.events = events;
        }
        await supabase.from('webhook_endpoints').update(updates).eq('id', webhook_id);
        return res.json({ success: true, message: 'Webhook updated.' });
    }

    // DELETE
    if (action === 'delete') {
        if (!webhook_id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'webhook_id required.' } });
        const { data: ep } = await supabase.from('webhook_endpoints').select('id').eq('id', webhook_id).eq('owner_id', ctx.owner_id).single();
        if (!ep) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Webhook not found or not yours.' } });
        await supabase.from('webhook_endpoints').delete().eq('id', webhook_id);
        return res.json({ success: true, message: 'Webhook deleted.' });
    }

    // ROTATE SECRET
    if (action === 'rotate_secret') {
        if (!webhook_id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'webhook_id required.' } });
        const { data: ep } = await supabase.from('webhook_endpoints').select('id').eq('id', webhook_id).eq('owner_id', ctx.owner_id).single();
        if (!ep) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Webhook not found or not yours.' } });
        const newSecret = crypto.randomBytes(24).toString('hex');
        await supabase.from('webhook_endpoints').update({ secret: newSecret }).eq('id', webhook_id);
        return res.json({ success: true, data: { secret: newSecret, secret_note: 'Update your app to use this new secret immediately.' } });
    }

    return res.status(400).json({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action.' } });
}
