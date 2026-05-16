import { createClient } from '@supabase/supabase-js';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

export const config = { api: { bodyParser: true } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PORTAL_URL  = process.env.SITE_URL || 'https://portal.mypayprotec.com';
const REDIRECT_URI = `${PORTAL_URL}/api/partner-oauth`;

// ── Token encryption (AES-256-GCM) ──────────────────────────────────────────
function getEncKey() {
    const hex = process.env.TOKEN_ENCRYPTION_KEY || '';
    if (hex.length < 64) throw new Error('TOKEN_ENCRYPTION_KEY must be a 64-char hex string');
    return Buffer.from(hex.slice(0, 64), 'hex');
}
function encrypt(text) {
    const key = getEncKey();
    const iv  = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
function decrypt(stored) {
    const [ivHex, tagHex, encHex] = stored.split(':');
    const key     = getEncKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

// ── HMAC state signing ───────────────────────────────────────────────────────
const STATE_SECRET = process.env.TOKEN_ENCRYPTION_KEY || 'fallback-secret';
function signState(payload) {
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig  = createHmac('sha256', STATE_SECRET).update(b64).digest('hex').slice(0, 16);
    return `${b64}.${sig}`;
}
function verifyState(state) {
    const [b64, sig] = state.split('.');
    const expected = createHmac('sha256', STATE_SECRET).update(b64).digest('hex').slice(0, 16);
    if (sig !== expected) return null;
    try { return JSON.parse(Buffer.from(b64, 'base64url').toString()); } catch { return null; }
}

// ── Token refresh helpers ────────────────────────────────────────────────────
async function refreshGoogleToken(refreshToken) {
    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id:     process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type:    'refresh_token'
        })
    });
    return r.json();
}
async function refreshMicrosoftToken(refreshToken) {
    const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id:     process.env.MICROSOFT_CLIENT_ID,
            client_secret: process.env.MICROSOFT_CLIENT_SECRET,
            refresh_token: refreshToken,
            grant_type:    'refresh_token',
            scope:         'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access'
        })
    });
    return r.json();
}

// ── Get a valid access token (refresh if needed) ─────────────────────────────
export async function getValidAccessToken(personId, provider) {
    const { data: conn } = await supabase
        .from('partner_email_connections')
        .select('access_token, refresh_token, token_expiry')
        .eq('person_id', personId)
        .eq('provider', provider)
        .single();
    if (!conn) return null;

    const accessToken  = decrypt(conn.access_token);
    const refreshToken = decrypt(conn.refresh_token);

    if (new Date(conn.token_expiry) > new Date(Date.now() + 60000)) return accessToken;

    // Refresh
    const fresh = provider === 'google'
        ? await refreshGoogleToken(refreshToken)
        : await refreshMicrosoftToken(refreshToken);

    if (!fresh.access_token) return null;

    const newExpiry = new Date(Date.now() + (fresh.expires_in || 3600) * 1000);
    await supabase.from('partner_email_connections').update({
        access_token:  encrypt(fresh.access_token),
        refresh_token: fresh.refresh_token ? encrypt(fresh.refresh_token) : conn.refresh_token,
        token_expiry:  newExpiry.toISOString(),
        updated_at:    new Date().toISOString()
    }).eq('person_id', personId).eq('provider', provider);

    return fresh.access_token;
}

// ── RFC 2047 encode a header value so non-ASCII (em dash, accents) survives ──
function encodeHeader(str) {
    return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

// ── Send email via Gmail API ─────────────────────────────────────────────────
export async function sendViaGoogle(accessToken, { to, subject, html, from }) {
    const mime = [
        `From: ${encodeHeader(from)}`,
        `To: ${to}`,
        `Subject: ${encodeHeader(subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        '',
        html
    ].join('\r\n');
    const encoded = Buffer.from(mime).toString('base64url');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: encoded })
    });
    return r.json();
}

// ── Send email via Microsoft Graph ──────────────────────────────────────────
export async function sendViaMicrosoft(accessToken, { to, subject, html }) {
    const r = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                subject,
                body:       { contentType: 'HTML', content: html },
                toRecipients: [{ emailAddress: { address: to } }]
            },
            saveToSentItems: true
        })
    });
    if (r.status === 202) return { success: true };
    return r.json();
}

// ── Main handler (GET — OAuth callback) ─────────────────────────────────────
export default async function handler(req, res) {
    const { code, state, error } = req.query;
    const redirect = (msg) => res.redirect(`${PORTAL_URL}/partner/settings?oauth_msg=${encodeURIComponent(msg)}`);

    if (error) return redirect('OAuth cancelled or denied.');
    if (!code || !state) return redirect('Invalid OAuth response.');

    const payload = verifyState(state);
    if (!payload) return redirect('Invalid OAuth state. Please try again.');

    const { personId, provider } = payload;
    if (!personId || !provider) return redirect('Missing session data.');

    try {
        let tokenRes, email;

        if (provider === 'google') {
            const r = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code,
                    client_id:     process.env.GOOGLE_CLIENT_ID,
                    client_secret: process.env.GOOGLE_CLIENT_SECRET,
                    redirect_uri:  REDIRECT_URI,
                    grant_type:    'authorization_code'
                })
            });
            tokenRes = await r.json();
            if (!tokenRes.access_token) return redirect('Google auth failed: ' + (tokenRes.error_description || tokenRes.error));
            // Get email
            const profile = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                headers: { Authorization: `Bearer ${tokenRes.access_token}` }
            })).json();
            email = profile.email;
        }

        if (provider === 'microsoft') {
            const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
            const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code,
                    client_id:     process.env.MICROSOFT_CLIENT_ID,
                    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
                    redirect_uri:  REDIRECT_URI,
                    grant_type:    'authorization_code',
                    scope:         'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access'
                })
            });
            tokenRes = await r.json();
            if (!tokenRes.access_token) return redirect('Microsoft auth failed: ' + (tokenRes.error_description || tokenRes.error));
            const profile = await (await fetch('https://graph.microsoft.com/v1.0/me', {
                headers: { Authorization: `Bearer ${tokenRes.access_token}` }
            })).json();
            email = profile.mail || profile.userPrincipalName;
        }

        const expiry = new Date(Date.now() + (tokenRes.expires_in || 3600) * 1000);
        await supabase.from('partner_email_connections').upsert({
            person_id:     personId,
            provider,
            email,
            access_token:  encrypt(tokenRes.access_token),
            refresh_token: encrypt(tokenRes.refresh_token || ''),
            token_expiry:  expiry.toISOString(),
            updated_at:    new Date().toISOString()
        }, { onConflict: 'person_id,provider' });

        return redirect(`Connected: ${email}`);
    } catch (err) {
        console.error('[partner-oauth]', err);
        return redirect('Error: ' + (err.message || 'Unknown error. Check Vercel logs.'));
    }
}
