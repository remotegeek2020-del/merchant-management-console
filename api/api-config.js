import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

// Derive a 32-byte AES key from the service role key so we never need a separate env var.
function getEncryptionKey() {
    const seed = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    return createHash('sha256').update(seed).digest(); // 32 bytes
}

function encrypt(plaintext) {
    const key = getEncryptionKey();
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        encrypted_value: encrypted.toString('hex'),
        iv: iv.toString('hex'),
        auth_tag: authTag.toString('hex')
    };
}

function decrypt(encrypted_value, iv, auth_tag) {
    const key = getEncryptionKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(auth_tag, 'hex'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encrypted_value, 'hex')),
        decipher.final()
    ]);
    return decrypted.toString('utf8');
}

function mask(value) {
    if (!value || value.length === 0) return 'Not configured';
    if (value.length < 5) return '****';
    return '****' + value.slice(-4);
}

export async function getConfigValue(key) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase.from('app_config').select('*').eq('key', key).single();
    if (error || !data) return null;
    try { return decrypt(data.encrypted_value, data.iv, data.auth_tag); } catch { return null; }
}

async function verifySuperAdmin(supabase, userid) {
    if (!userid) return false;
    const { data } = await supabase
        .from('app_users')
        .select('role, is_active')
        .eq('userid', userid)
        .single();
    return data?.is_active === true && data?.role === 'super_admin';
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, userid } = req.body;

    const authorized = await verifySuperAdmin(supabase, userid);
    if (!authorized) return res.status(403).json({ success: false, message: 'Access denied.' });

    try {
        // List config keys with masked values and timestamps — no plaintext ever sent to client
        if (action === 'list_status') {
            const { data, error } = await supabase
                .from('app_config')
                .select('key, encrypted_value, iv, auth_tag, updated_at, updated_by')
                .order('key');
            if (error) throw error;

            const result = (data || []).map(row => {
                let masked = '••••••••';
                try { masked = mask(decrypt(row.encrypted_value, row.iv, row.auth_tag)); } catch {}
                return { key: row.key, masked, updated_at: row.updated_at, updated_by: row.updated_by };
            });
            return res.status(200).json({ success: true, configs: result });
        }

        // Set (upsert) a config value — encrypts before storing
        if (action === 'set') {
            const { key, value, updated_by } = req.body;
            if (!key?.trim()) return res.status(400).json({ success: false, message: 'Key is required.' });
            if (!value?.trim()) return res.status(400).json({ success: false, message: 'Value is required.' });

            const { encrypted_value, iv, auth_tag } = encrypt(value.trim());
            const { error } = await supabase.from('app_config').upsert({
                key: key.trim(),
                encrypted_value, iv, auth_tag,
                updated_at: new Date().toISOString(),
                updated_by: updated_by || 'unknown'
            }, { onConflict: 'key' });
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // Delete a config key
        if (action === 'delete') {
            const { key } = req.body;
            if (!key) return res.status(400).json({ success: false, message: 'Key is required.' });
            const { error } = await supabase.from('app_config').delete().eq('key', key);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });
    } catch (err) {
        console.error('API Config Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
