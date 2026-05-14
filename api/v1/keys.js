import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const config = { api: { bodyParser: true } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function hashKey(rawKey) {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
}

function generateApiKey() {
    const raw = 'pk_live_' + crypto.randomBytes(24).toString('hex');
    return raw;
}

async function validatePartnerToken(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions')
        .select('person_id, expires_at')
        .eq('session_token', token)
        .single();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

async function validateStaffSession(req) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const token = auth.slice(7).trim();
    const { data } = await supabase.from('staff_sessions')
        .select('userid, expires_at')
        .eq('session_token', token)
        .maybeSingle();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return { userid: data.userid };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

    const { action, token: partnerToken, key_id, label, tier } = req.body || {};

    // ── PARTNER ACTIONS ──────────────────────────────────────
    const PARTNER_ACTIONS = new Set(['create', 'list', 'revoke']);

    if (PARTNER_ACTIONS.has(action)) {
        const ownerId = await validatePartnerToken(partnerToken);
        if (!ownerId) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired partner session.' } });

        // CREATE KEY
        if (action === 'create') {
            const keyLabel = (label || 'My API Key').trim().slice(0, 60);

            // Enforce max 10 keys per partner
            const { count } = await supabase.from('api_keys')
                .select('id', { count: 'exact', head: true })
                .eq('owner_id', ownerId)
                .eq('is_active', true);
            if (count >= 10) return res.status(400).json({ success: false, error: { code: 'LIMIT_REACHED', message: 'Maximum 10 active API keys allowed.' } });

            const rawKey = generateApiKey();
            const keyHash = hashKey(rawKey);
            const keyPrefix = rawKey.slice(0, 15) + '...';

            const { data, error } = await supabase.from('api_keys').insert({
                key_hash: keyHash,
                key_prefix: keyPrefix,
                label: keyLabel,
                owner_id: ownerId,
                tier: 'free'
            }).select('id, label, key_prefix, tier, created_at').single();

            if (error) return res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: 'Failed to create key.' } });

            // Return the raw key ONLY once — never stored, never retrievable again
            return res.json({ success: true, data: { ...data, raw_key: rawKey, shown_once: true } });
        }

        // LIST OWN KEYS
        if (action === 'list') {
            const { data } = await supabase.from('api_keys')
                .select('id, label, key_prefix, tier, is_active, last_used_at, created_at')
                .eq('owner_id', ownerId)
                .order('created_at', { ascending: false });
            return res.json({ success: true, data: data || [] });
        }

        // REVOKE OWN KEY
        if (action === 'revoke') {
            if (!key_id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'key_id required.' } });
            // Verify ownership before revoking
            const { data: key } = await supabase.from('api_keys').select('id').eq('id', key_id).eq('owner_id', ownerId).single();
            if (!key) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Key not found or not yours.' } });
            await supabase.from('api_keys').update({ is_active: false }).eq('id', key_id);
            return res.json({ success: true, message: 'Key revoked.' });
        }
    }

    // ── STAFF ACTIONS ─────────────────────────────────────────
    const staff = await validateStaffSession(req);
    if (!staff) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Staff session required.' } });

    // LIST ALL KEYS (staff)
    if (action === 'list_all') {
        const { data } = await supabase.from('api_keys')
            .select('id, label, key_prefix, tier, is_active, last_used_at, created_at, owner_id, persons(full_name)')
            .order('created_at', { ascending: false });
        return res.json({ success: true, data: data || [] });
    }

    // SET TIER (staff)
    if (action === 'set_tier') {
        if (!key_id || !tier) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'key_id and tier required.' } });
        if (!['free', 'standard', 'enterprise'].includes(tier)) return res.status(400).json({ success: false, error: { code: 'INVALID_TIER', message: 'Invalid tier.' } });
        await supabase.from('api_keys').update({ tier }).eq('id', key_id);
        return res.json({ success: true, message: 'Tier updated.' });
    }

    // REVOKE ANY KEY (staff)
    if (action === 'revoke_any') {
        if (!key_id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'key_id required.' } });
        await supabase.from('api_keys').update({ is_active: false }).eq('id', key_id);
        return res.json({ success: true, message: 'Key revoked.' });
    }

    // REACTIVATE KEY (staff)
    if (action === 'reactivate') {
        if (!key_id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'key_id required.' } });
        await supabase.from('api_keys').update({ is_active: true }).eq('id', key_id);
        return res.json({ success: true, message: 'Key reactivated.' });
    }

    return res.status(400).json({ success: false, error: { code: 'UNKNOWN_ACTION', message: 'Unknown action.' } });
}
