import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const RATE_LIMITS = {
    free:       { per_minute: 10,  per_day: 500 },
    standard:   { per_minute: 60,  per_day: 5000 },
    enterprise: { per_minute: 300, per_day: 50000 }
};

export async function validateApiKey(req, res) {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer pk_live_')) {
        res.status(401).json({ success: false, error: { code: 'MISSING_KEY', message: 'Provide your API key in the Authorization header: Bearer pk_live_...' } });
        return null;
    }

    const rawKey = auth.slice(7).trim();
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const { data: key } = await supabase.from('api_keys')
        .select('id, owner_id, tier, is_active')
        .eq('key_hash', keyHash)
        .maybeSingle();

    if (!key) {
        res.status(401).json({ success: false, error: { code: 'INVALID_KEY', message: 'API key not found.' } });
        return null;
    }

    if (!key.is_active) {
        res.status(401).json({ success: false, error: { code: 'KEY_REVOKED', message: 'This API key has been revoked.' } });
        return null;
    }

    const limits = RATE_LIMITS[key.tier] || RATE_LIMITS.free;

    // Check per-minute limit
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const { count: minuteCount } = await supabase.from('api_usage_log')
        .select('id', { count: 'exact', head: true })
        .eq('api_key_id', key.id)
        .gte('created_at', oneMinuteAgo);

    if (minuteCount >= limits.per_minute) {
        res.setHeader('X-RateLimit-Limit', limits.per_minute);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', new Date(Date.now() + 60000).toISOString());
        res.setHeader('Retry-After', 60);
        res.status(429).json({ success: false, error: { code: 'RATE_LIMIT_EXCEEDED', message: `Rate limit exceeded. Max ${limits.per_minute} requests/minute on the ${key.tier} tier.`, retry_after: 60 } });
        return null;
    }

    // Check per-day limit
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const { count: dayCount } = await supabase.from('api_usage_log')
        .select('id', { count: 'exact', head: true })
        .eq('api_key_id', key.id)
        .gte('created_at', startOfDay.toISOString());

    const dayRemaining = limits.per_day - dayCount;
    if (dayRemaining <= 0) {
        const resetAt = new Date(); resetAt.setHours(24,0,0,0);
        res.setHeader('X-RateLimit-Daily-Limit', limits.per_day);
        res.setHeader('X-RateLimit-Daily-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', resetAt.toISOString());
        res.status(429).json({ success: false, error: { code: 'DAILY_LIMIT_EXCEEDED', message: `Daily limit of ${limits.per_day} requests reached. Resets at midnight UTC.`, retry_after: Math.floor((resetAt - Date.now()) / 1000) } });
        return null;
    }

    // Set rate limit headers on success
    res.setHeader('X-RateLimit-Limit', limits.per_minute);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limits.per_minute - minuteCount - 1));
    res.setHeader('X-RateLimit-Daily-Limit', limits.per_day);
    res.setHeader('X-RateLimit-Daily-Remaining', dayRemaining - 1);

    // Log usage + update last_used (fire-and-forget — don't block the response)
    const endpoint = req.url || '';
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || '';
    Promise.all([
        supabase.from('api_usage_log').insert({ api_key_id: key.id, endpoint, method: req.method, ip_address: ip }),
        supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id)
    ]).catch(() => {});

    return { key_id: key.id, owner_id: key.owner_id, tier: key.tier };
}

export function metaEnvelope(data, extra = {}) {
    return { success: true, data, meta: { ...extra } };
}
