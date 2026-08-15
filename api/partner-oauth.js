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
            scope:         'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access'
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

    if (!fresh.access_token) {
        // Refresh token is dead (expired or revoked) — remove stale connection so
        // Settings correctly shows "Not connected" instead of a broken Connected state.
        await supabase.from('partner_email_connections')
            .delete().eq('person_id', personId).eq('provider', provider);
        return null;
    }

    const newExpiry = new Date(Date.now() + (fresh.expires_in || 3600) * 1000);
    await supabase.from('partner_email_connections').update({
        access_token:  encrypt(fresh.access_token),
        refresh_token: fresh.refresh_token ? encrypt(fresh.refresh_token) : conn.refresh_token,
        token_expiry:  newExpiry.toISOString(),
        updated_at:    new Date().toISOString()
    }).eq('person_id', personId).eq('provider', provider);

    return fresh.access_token;
}

// ── Get a valid access token for a SHARED CRM mailbox (crm_mailboxes row) ────
export async function getValidSharedMailboxToken(mailboxId) {
    const { data: mb } = await supabase
        .from('crm_mailboxes')
        .select('id, provider, access_token, refresh_token, token_expiry')
        .eq('id', mailboxId)
        .single();
    if (!mb || !mb.access_token) return null;

    const accessToken  = decrypt(mb.access_token);
    const refreshToken = decrypt(mb.refresh_token);

    if (new Date(mb.token_expiry) > new Date(Date.now() + 60000)) return accessToken;

    const fresh = mb.provider === 'google'
        ? await refreshGoogleToken(refreshToken)
        : await refreshMicrosoftToken(refreshToken);

    if (!fresh.access_token) {
        await supabase.from('crm_mailboxes').update({ status: 'error', updated_at: new Date().toISOString() }).eq('id', mailboxId);
        return null;
    }

    const newExpiry = new Date(Date.now() + (fresh.expires_in || 3600) * 1000);
    await supabase.from('crm_mailboxes').update({
        access_token:  encrypt(fresh.access_token),
        refresh_token: fresh.refresh_token ? encrypt(fresh.refresh_token) : mb.refresh_token,
        token_expiry:  newExpiry.toISOString(),
        status:        'active',
        updated_at:    new Date().toISOString()
    }).eq('id', mailboxId);

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

    // Return the user to the ORIGINATING (branded) page so their per-domain
    // session survives — the callback lives on the portal domain, but branded
    // users must land back on their own domain. Only same-family hosts allowed.
    let retUrl = null;
    try {
        if (payload.ret && /^https:\/\//i.test(payload.ret)) {
            const u = new URL(payload.ret);
            const host = u.hostname.toLowerCase();
            let ok = ['portal.mypayprotec.com', 'app.mypayprotec.com'].includes(host);
            if (!ok) { const { data } = await supabase.from('portal_brands').select('host').eq('host', host).eq('active', true).maybeSingle(); ok = !!data; }
            if (ok) retUrl = u.origin + u.pathname;
        }
    } catch (e) {}
    const done = (msg) => res.redirect((retUrl || `${PORTAL_URL}/partner/settings`) + '?oauth_msg=' + encodeURIComponent(msg));

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
            if (!tokenRes.access_token) return done('Google auth failed: ' + (tokenRes.error_description || tokenRes.error));
            // Extract email from id_token JWT (openid email scope — no extra API call needed)
            const idPayload = JSON.parse(Buffer.from(tokenRes.id_token.split('.')[1], 'base64url').toString());
            email = idPayload.email;
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
                    scope:         'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access'
                })
            });
            tokenRes = await r.json();
            if (!tokenRes.access_token) return done('Microsoft auth failed: ' + (tokenRes.error_description || tokenRes.error));
            const profile = await (await fetch('https://graph.microsoft.com/v1.0/me', {
                headers: { Authorization: `Bearer ${tokenRes.access_token}` }
            })).json();
            email = profile.mail || profile.userPrincipalName;
        }

        const expiry = new Date(Date.now() + (tokenRes.expires_in || 3600) * 1000);

        // Shared CRM mailbox (state.scope==='shared', signed when the connect URL
        // was generated after an owner/admin access check) → crm_mailboxes.
        if (payload.scope === 'shared' && payload.sub_account_id) {
            const { data: sub } = await supabase.from('agency_sub_accounts').select('portal_id').eq('id', payload.sub_account_id).single();
            await supabase.from('crm_mailboxes').upsert({
                sub_account_id: payload.sub_account_id,
                portal_id:      sub ? sub.portal_id : null,
                provider,
                email,
                access_token:   encrypt(tokenRes.access_token),
                refresh_token:  encrypt(tokenRes.refresh_token || ''),
                token_expiry:   expiry.toISOString(),
                status:         'active',
                connected_by:   personId,
                updated_at:     new Date().toISOString()
            }, { onConflict: 'sub_account_id,email' });
            return done(`Shared mailbox connected: ${email}`);
        }

        await supabase.from('partner_email_connections').upsert({
            person_id:     personId,
            provider,
            email,
            access_token:  encrypt(tokenRes.access_token),
            refresh_token: encrypt(tokenRes.refresh_token || ''),
            token_expiry:  expiry.toISOString(),
            updated_at:    new Date().toISOString()
        }, { onConflict: 'person_id,provider' });

        return done(`Connected: ${email}`);
    } catch (err) {
        console.error('[partner-oauth]', err);
        return done('Error: ' + (err.message || 'Unknown error. Check Vercel logs.'));
    }
}
