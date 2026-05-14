import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const VALID_EVENTS = ['ticket.created', 'ticket.updated', 'ticket.comment_added', 'merchant.status_changed'];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');
    const supabaseClient = supabase;
    const { action, type, config, events, is_enabled } = req.body || {};

    try {
        // LIST ALL
        if (action === 'list') {
            const { data } = await supabaseClient.from('integrations')
                .select('id, type, label, is_enabled, events, config, last_triggered_at, last_status, updated_at')
                .order('created_at');
            // Mask secrets in config before returning
            const masked = (data || []).map(i => ({
                ...i,
                config: maskConfig(i.config)
            }));
            return res.json({ success: true, data: masked });
        }

        // GET ONE (with full config for editing)
        if (action === 'get') {
            if (!type) return res.status(400).json({ success: false, message: 'type required.' });
            const { data } = await supabaseClient.from('integrations').select('*').eq('type', type).single();
            if (!data) return res.status(404).json({ success: false, message: 'Integration not found.' });
            return res.json({ success: true, data: { ...data, config: maskConfig(data.config) } });
        }

        // SAVE CONFIG
        if (action === 'save') {
            if (!type) return res.status(400).json({ success: false, message: 'type required.' });
            const updates = { updated_at: new Date().toISOString() };
            if (config !== undefined) {
                // Merge new config with existing (so partial updates don't wipe other fields)
                const { data: existing } = await supabaseClient.from('integrations').select('config').eq('type', type).single();
                updates.config = { ...(existing?.config || {}), ...config };
            }
            if (events !== undefined) {
                const invalid = events.filter(e => !VALID_EVENTS.includes(e));
                if (invalid.length) return res.status(400).json({ success: false, message: `Unknown events: ${invalid.join(', ')}` });
                updates.events = events;
            }
            if (is_enabled !== undefined) updates.is_enabled = is_enabled;
            await supabaseClient.from('integrations').update(updates).eq('type', type);
            return res.json({ success: true, message: 'Integration saved.' });
        }

        // TOGGLE ENABLED
        if (action === 'toggle') {
            if (!type) return res.status(400).json({ success: false, message: 'type required.' });
            const { data: current } = await supabaseClient.from('integrations').select('is_enabled').eq('type', type).single();
            if (!current) return res.status(404).json({ success: false, message: 'Integration not found.' });
            await supabaseClient.from('integrations').update({ is_enabled: !current.is_enabled, updated_at: new Date().toISOString() }).eq('type', type);
            return res.json({ success: true, is_enabled: !current.is_enabled });
        }

        // TEST — send a test payload to the configured endpoint
        if (action === 'test') {
            if (!type) return res.status(400).json({ success: false, message: 'type required.' });
            const { data: integration } = await supabaseClient.from('integrations').select('*').eq('type', type).single();
            if (!integration) return res.status(404).json({ success: false, message: 'Integration not found.' });

            const testPayload = {
                event: 'test',
                data: { message: 'This is a test event from PayProTec.', timestamp: new Date().toISOString() }
            };

            let result = { success: false, status: 0 };

            if (type === 'slack') {
                const url = integration.config?.webhook_url;
                if (!url) return res.status(400).json({ success: false, message: 'No Slack webhook URL configured.' });
                try {
                    const r = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: '✅ *PayProTec Test* — Your Slack integration is working!' }),
                        signal: AbortSignal.timeout(8000)
                    });
                    result = { success: r.ok, status: r.status };
                } catch (e) { result = { success: false, status: 0, error: e.message }; }

            } else if (type === 'zapier' || type === 'webhook') {
                const url = integration.config?.webhook_url;
                if (!url) return res.status(400).json({ success: false, message: 'No webhook URL configured.' });
                try {
                    const r = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'X-PayProTec-Event': 'test', 'User-Agent': 'PayProTec-Webhooks/1.0' },
                        body: JSON.stringify(testPayload),
                        signal: AbortSignal.timeout(8000)
                    });
                    result = { success: r.ok, status: r.status };
                } catch (e) { result = { success: false, status: 0, error: e.message }; }
            }

            await supabaseClient.from('integrations').update({ last_triggered_at: new Date().toISOString(), last_status: result.status }).eq('type', type);
            return res.json({ success: result.success, status: result.status, error: result.error || null });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });

    } catch (err) {
        console.error('[INTEGRATIONS]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

function maskConfig(config) {
    if (!config) return {};
    const masked = { ...config };
    // Show only last 6 chars of webhook URLs for display
    if (masked.webhook_url && masked.webhook_url.length > 10) {
        masked.webhook_url_preview = '••••••••' + masked.webhook_url.slice(-20);
    }
    return masked;
}
