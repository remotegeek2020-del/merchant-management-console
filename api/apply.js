import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function logActivity({ action, category, status, target_id, ip, ua }) {
    supabase.from('activity_logs').insert({
        email: 'system@apply',
        action,
        status: status || 'success',
        category: category || 'merchants',
        target_id: target_id ? String(target_id) : null,
        target_type: 'merchant',
        severity: 'info',
        user_agent: ua || 'Self-Onboarding',
        ip_address: ip || 'External'
    }).then(() => {}).catch(e => console.error('[ApplyLog]', e.message));
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // ── GET: Partner name lookup ─────────────────────────────────────────────
    if (req.method === 'GET') {
        const { lookup } = req.query;
        if (!lookup) {
            return res.status(400).json({ success: false, message: 'lookup param required' });
        }

        try {
            // Look up agent_identifier → agent → person
            const { data: ident } = await supabase
                .from('agent_identifiers')
                .select('agent_id')
                .eq('id_string', lookup)
                .maybeSingle();

            if (!ident) {
                return res.status(200).json({ success: true, partner_name: null });
            }

            const { data: agent } = await supabase
                .from('agents')
                .select('agent_name, parent_agent_id, persons:parent_agent_id(full_name)')
                .eq('id', ident.agent_id)
                .maybeSingle();

            const partner_name = agent?.persons?.full_name || agent?.agent_name || null;
            return res.status(200).json({ success: true, partner_name });
        } catch (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    // ── POST: Submit merchant application ────────────────────────────────────
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    try {
        const body = req.body || {};
        const {
            dba_name, legal_name, business_type,
            owner_name, email, phone,
            address, city, state, zip,
            agent_id, monthly_volume, referral_source
        } = body;

        // Required field validation
        const requiredFields = ['dba_name', 'owner_name', 'email', 'phone', 'address', 'city', 'state', 'zip'];
        const missing = requiredFields.filter(f => !body[f] || !String(body[f]).trim());
        if (missing.length > 0) {
            return res.status(400).json({ success: false, missing });
        }

        // Resolve agent_id if provided
        let resolvedAgentId = null;
        if (agent_id && String(agent_id).trim()) {
            const agentIdStr = String(agent_id).trim();
            const { data: ident } = await supabase
                .from('agent_identifiers')
                .select('id_string')
                .eq('id_string', agentIdStr)
                .maybeSingle();
            if (ident) {
                resolvedAgentId = agentIdStr;
            }
            // If not found, default to null — don't reject
        }

        // Duplicate submission check: same email within 24 hours, same source
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: existing } = await supabase
            .from('merchants')
            .select('id')
            .eq('email', String(email).trim().toLowerCase())
            .eq('source', 'self_onboarding')
            .gte('created_at', cutoff)
            .maybeSingle();

        if (existing) {
            return res.status(409).json({
                success: false,
                message: 'Application already submitted. Please wait 24 hours before resubmitting.'
            });
        }

        // Insert merchant record
        const { data: merchant, error: insertErr } = await supabase
            .from('merchants')
            .insert([{
                dba_name: String(dba_name).trim(),
                legal_name: legal_name ? String(legal_name).trim() : null,
                business_type: business_type || null,
                owner_name: String(owner_name).trim(),
                email: String(email).trim().toLowerCase(),
                phone: String(phone).trim(),
                address: String(address).trim(),
                city: String(city).trim(),
                state: String(state).trim(),
                zip: String(zip).trim(),
                account_status: 'Pending',
                source: 'self_onboarding',
                agent_id: resolvedAgentId,
                monthly_volume: monthly_volume || null,
                referral_source: referral_source || null
            }])
            .select('id, merchant_id')
            .single();

        if (insertErr) {
            console.error('[Apply] Insert error:', insertErr.message);
            return res.status(500).json({ success: false, message: 'Failed to submit application. Please try again.' });
        }

        // Log to activity_logs
        logActivity({
            action: 'Self-Onboarding Submission',
            category: 'merchants',
            status: 'success',
            target_id: merchant.merchant_id || merchant.id,
            ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'External',
            ua: req.headers['user-agent']
        });

        return res.status(200).json({
            success: true,
            reference: merchant.merchant_id || merchant.id
        });

    } catch (err) {
        console.error('[Apply] Error:', err.message);
        return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
    }
}
