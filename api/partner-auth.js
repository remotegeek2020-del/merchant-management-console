import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { validateSession as validateStaffSession } from './_validate.js';
import { loadActor } from './_access.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function hashPassword(password) {
    return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}

function generateToken(length = 48) {
    return crypto.randomBytes(length).toString('hex');
}

async function createSession(personId, req) {
    const token = generateToken();
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await supabase.from('partner_sessions').insert({
        person_id: personId,
        session_token: token,
        expires_at: expires.toISOString(),
        ip_address: req.headers['x-forwarded-for'] || '',
        user_agent: req.headers['user-agent'] || ''
    });
    return token;
}

async function validateSession(token) {
    if (!token) return null;
    const { data, error } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).single();
    if (error || !data) return null;
    if (new Date(data.expires_at) < new Date()) {
        await supabase.from('partner_sessions').delete().eq('session_token', token);
        return null;
    }
    // Sliding window: if less than 3 days remain, extend by 7 more days
    const msRemaining = new Date(data.expires_at) - new Date();
    if (msRemaining < 3 * 24 * 60 * 60 * 1000) {
        const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await supabase.from('partner_sessions').update({ expires_at: newExpiry.toISOString() }).eq('session_token', token);
    }
    return data.person_id;
}

function sha256(v) {
    return crypto.createHash('sha256').update(String(v)).digest('hex');
}

// Branded-domain access gate: on a white-label host, only members of THAT agency may log
// in. Canonical PayProTec hosts (and unknown hosts) impose no restriction — everyone can
// always use portal.mypayprotec.com/partner.
async function agencyHostGate(host, personId) {
    const h = String(host || '').toLowerCase().replace(/^www\./, '').trim();
    const CANON = ['', 'portal.mypayprotec.com', 'app.mypayprotec.com', 'localhost', '127.0.0.1'];
    if (CANON.indexOf(h) >= 0) return { ok: true };
    const { data: brand } = await supabase.from('portal_brands').select('portal_id, name').eq('host', h).maybeSingle();
    if (!brand || !brand.portal_id) return { ok: true }; // not a known agency domain → no gate
    const { data: mem } = await supabase.from('partner_portal_members').select('id').eq('portal_id', brand.portal_id).eq('person_id', personId).maybeSingle();
    if (mem) return { ok: true };
    return { ok: false, name: brand.name || 'this agency' };
}

// Shared magic-link email body.
async function sendMagicEmail(person, magicUrl) {
    if (!process.env.POSTMARK_SERVER_TOKEN) { console.log(`[MAGIC LINK] ${person.email} -> ${magicUrl}`); return; }
    try {
        const { ServerClient } = await import('postmark');
        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
        await client.sendEmail({
            From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
            To: person.email,
            Subject: 'Your PayProTec Partner Portal sign-in link',
            HtmlBody: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;border:1px solid #e2e8f0;border-radius:16px;">
                <img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:36px;margin-bottom:24px;display:block;">
                <h2 style="color:#001e3c;font-size:22px;margin-bottom:8px;">Sign in to your Partner Portal</h2>
                <p style="color:#475569;line-height:1.6;margin-bottom:24px;">Hi <strong>${person.full_name || 'there'}</strong>, click the button below to sign in instantly — no password needed.</p>
                <div style="text-align:center;margin:28px 0;">
                    <a href="${magicUrl}" style="display:inline-block;padding:14px 32px;background:#0d9488;color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">Sign In →</a>
                </div>
                <p style="color:#94a3b8;font-size:12px;line-height:1.5;">This link expires in 15 minutes and can be used once. If you didn't request it, you can safely ignore this email.</p>
                <hr style="border:0;border-top:1px solid #f1f5f9;margin:24px 0;">
                <p style="font-size:11px;color:#94a3b8;text-align:center;">PayProTec Partner Portal · Secure Access</p>
            </div>`,
            TextBody: `Hi ${person.full_name || 'there'}, sign in to your PayProTec Partner Portal (expires in 15 minutes, single use): ${magicUrl}`,
            MessageStream: 'outbound'
        });
    } catch (emailErr) { console.error('[MAGIC LINK] Email failed:', emailErr.message); }
}

async function getPartnerAgentIds(personId) {
    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    if (!agents || agents.length === 0) return [];
    const { data: identifiers } = await supabase.from('agent_identifiers').select('id_string, rev_share, prime49').in('agent_id', agents.map(a => a.id));
    return identifiers || [];
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    const { action } = req.body || {};
    if (!action) return res.status(400).json({ success: false, message: 'No action provided' });

    try {

        // ── GOD MODE: super-admin "Login As" a partner (impersonation) ──
        // Mints a partner session for ANY person. Requires a valid staff super_admin
        // session (Authorization: Bearer <pp_session_token>). Lets an admin jump into
        // any partner's portal / agency — the HighLevel "Login As" equivalent.
        if (action === 'admin_login_as') {
            const staff = await validateStaffSession(req);
            if (!staff) return res.status(401).json({ success: false, message: 'Staff session required.' });
            const actor = await loadActor(staff.userid);
            if (!actor || !actor.is_active || String(actor.role || '').toLowerCase() !== 'super_admin') {
                return res.status(403).json({ success: false, message: 'Super admin only.' });
            }
            const { person_id } = req.body;
            if (!person_id) return res.status(400).json({ success: false, message: 'person_id required.' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email, is_portal_active').eq('id', person_id).single();
            if (!person) return res.status(404).json({ success: false, message: 'Partner not found.' });
            const token = await createSession(person.id, req);
            console.log(`[LOGIN AS] ${actor.userid} -> partner ${person.email} (${person.id})`);
            return res.status(200).json({ success: true, token, partner: { id: person.id, name: person.full_name, email: person.email } });
        }

        if (action === 'login') {
            const { email, password } = req.body;
            if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required.' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email, is_portal_active, password_hash, portal_password_set').eq('email', email.toLowerCase().trim()).single();
            if (!person) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
            if (!person.is_portal_active) return res.status(403).json({ success: false, message: 'Your portal access is not yet activated. Check your email for an invite.' });
            if (!person.portal_password_set) return res.status(403).json({ success: false, message: 'Please complete your account setup using the invite link sent to your email.' });
            if (!await verifyPassword(password, person.password_hash)) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
            // Branded-domain gate: on a white-label host, only that agency's members may sign in.
            const gate = await agencyHostGate(req.body.host, person.id);
            if (!gate.ok) return res.status(403).json({ success: false, message: 'This portal is for ' + (gate.name || 'this agency') + '. Please sign in at portal.mypayprotec.com/partner.' });
            const token = await createSession(person.id, req);
            await supabase.from('persons').update({ last_portal_login: new Date().toISOString() }).eq('id', person.id);
            return res.status(200).json({ success: true, token, partner: { id: person.id, name: person.full_name, email: person.email } });
        }

        // ── AGENCY INVITE: verify + accept (team members from outside the program) ──
        if (action === 'verify_invite') {
            const { token } = req.body;
            const { data: inv } = await supabase.from('agency_invites').select('*').eq('token', token).eq('status', 'pending').maybeSingle();
            if (!inv || (inv.expires_at && new Date(inv.expires_at) < new Date())) return res.status(400).json({ success: false, message: 'This invite is invalid or has expired.' });
            const { data: portal } = await supabase.from('partner_portals').select('agency_name').eq('id', inv.portal_id).maybeSingle();
            const { data: existing } = await supabase.from('persons').select('id, portal_password_set').ilike('email', inv.email).limit(1);
            const hasAccount = !!(existing && existing.length && existing[0].portal_password_set);
            return res.status(200).json({ success: true, invite: { email: inv.email, role: inv.role, agency_name: (portal && portal.agency_name) || 'the agency', has_account: hasAccount } });
        }

        if (action === 'accept_invite') {
            const { token, full_name, password } = req.body;
            const { data: inv } = await supabase.from('agency_invites').select('*').eq('token', token).eq('status', 'pending').maybeSingle();
            if (!inv || (inv.expires_at && new Date(inv.expires_at) < new Date())) return res.status(400).json({ success: false, message: 'This invite is invalid or has expired.' });
            let personId;
            const { data: existing } = await supabase.from('persons').select('id, portal_password_set').ilike('email', inv.email).limit(1);
            if (existing && existing.length) {
                personId = existing[0].id;
                if (!existing[0].portal_password_set) {
                    if (!password || String(password).length < 8) return res.status(400).json({ success: false, message: 'Choose a password (at least 8 characters).' });
                    const patch = { password_hash: await hashPassword(password), portal_password_set: true, is_portal_active: true };
                    if (full_name) patch.full_name = full_name;
                    await supabase.from('persons').update(patch).eq('id', personId);
                }
            } else {
                if (!password || String(password).length < 8) return res.status(400).json({ success: false, message: 'Choose a password (at least 8 characters).' });
                const { data: np, error } = await supabase.from('persons').insert({ full_name: full_name || inv.email.split('@')[0], email: inv.email.toLowerCase(), password_hash: await hashPassword(password), portal_password_set: true, is_portal_active: true }).select('id').single();
                if (error || !np) return res.status(500).json({ success: false, message: 'Could not create your account.' });
                personId = np.id;
            }
            await supabase.from('partner_portal_members').upsert({ portal_id: inv.portal_id, person_id: personId, role: inv.role, scope: inv.scope || {}, permissions: inv.permissions || {}, added_by: inv.invited_by }, { onConflict: 'portal_id,person_id' });
            await supabase.from('agency_invites').update({ status: 'accepted', accepted_person_id: personId }).eq('id', inv.id);
            const sess = await createSession(personId, req);
            const { data: person } = await supabase.from('persons').select('full_name, email').eq('id', personId).maybeSingle();
            return res.status(200).json({ success: true, token: sess, partner: { id: personId, name: (person && person.full_name) || '', email: (person && person.email) || inv.email } });
        }

        if (action === 'validate') {
            const { token } = req.body;
            const personId = await validateSession(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email, is_portal_active, is_branded').eq('id', personId).single();
            if (!person || !person.is_portal_active) return res.status(401).json({ success: false });
            const identifiers = await getPartnerAgentIds(personId);
            return res.status(200).json({ success: true, partner: { id: person.id, name: person.full_name, email: person.email, is_branded: !!person.is_branded }, identifiers });
        }

        // ── MAGIC LINK: request a one-time sign-in link ──
        // Always returns success (no email enumeration). Only activated partners
        // get an email. Token is 256-bit, stored hashed, single-use, 15-min TTL.
        if (action === 'request_magic_link') {
            const email = (req.body.email || '').toLowerCase().trim();
            // Hybrid feedback: unknown emails stay vague (no enumeration), but a
            // known-but-inactive partner is told to contact their rep.
            if (!email) return res.status(200).json({ success: true, status: 'generic' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email, is_portal_active').eq('email', email).single();
            if (!person) return res.status(200).json({ success: true, status: 'generic' });
            if (!person.is_portal_active) return res.status(200).json({ success: true, status: 'inactive' });
            // Light rate limit: skip if a link was issued in the last 45s.
            const { data: recent } = await supabase.from('partner_magic_links')
                .select('created_at').eq('person_id', person.id).order('created_at', { ascending: false }).limit(1);
            const tooSoon = recent && recent[0] && (Date.now() - new Date(recent[0].created_at).getTime() < 45000);
            if (!tooSoon) {
                const token = generateToken(32); // 256-bit
                const expires = new Date(Date.now() + 15 * 60 * 1000);
                await supabase.from('partner_magic_links').insert({
                    person_id: person.id, token_hash: sha256(token), expires_at: expires.toISOString(),
                    ip_address: req.headers['x-forwarded-for'] || ''
                });
                const magicUrl = `${process.env.SITE_URL || 'https://portal.mypayprotec.com'}/partner?magic=${token}`;
                await sendMagicEmail(person, magicUrl);
            }
            return res.status(200).json({ success: true, status: 'sent' });
        }

        // ── MAGIC LINK: consume a link and start a session ──
        if (action === 'consume_magic_link') {
            const token = req.body.token;
            if (!token) return res.status(400).json({ success: false, message: 'No link provided.' });
            const tokenHash = sha256(token);
            const { data: link } = await supabase.from('partner_magic_links')
                .select('id, person_id, expires_at, used_at').eq('token_hash', tokenHash).single();
            if (!link || link.used_at) return res.status(400).json({ success: false, message: 'This sign-in link is invalid or has already been used. Request a new one.' });
            if (new Date(link.expires_at) < new Date()) return res.status(400).json({ success: false, message: 'This sign-in link has expired. Request a new one.' });
            // Mark used FIRST (single-use guard against double-submit / replay).
            const { data: claimed } = await supabase.from('partner_magic_links')
                .update({ used_at: new Date().toISOString() }).eq('id', link.id).is('used_at', null).select('id');
            if (!claimed || !claimed.length) return res.status(400).json({ success: false, message: 'This sign-in link has already been used. Request a new one.' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email, is_portal_active').eq('id', link.person_id).single();
            if (!person || !person.is_portal_active) return res.status(403).json({ success: false, message: 'Your portal access is not active. Contact your PayProTec representative.' });
            const sessionToken = await createSession(person.id, req);
            await supabase.from('persons').update({ last_portal_login: new Date().toISOString() }).eq('id', person.id);
            return res.status(200).json({ success: true, token: sessionToken, partner: { id: person.id, name: person.full_name, email: person.email } });
        }

        // ── ADMIN: send a magic sign-in link to one or many partners ──
        if (action === 'send_magic_link') {
            const ids = Array.isArray(req.body.person_ids) ? req.body.person_ids : (req.body.person_id ? [req.body.person_id] : []);
            if (!ids.length) return res.status(400).json({ success: false, message: 'person_id(s) required' });
            const { data: persons } = await supabase.from('persons').select('id, full_name, email, is_portal_active').in('id', ids);
            const results = { sent: [], skipped: [] };
            for (const person of (persons || [])) {
                if (!person.email || !person.is_portal_active) { results.skipped.push(person.full_name || person.id); continue; }
                const token = generateToken(32);
                const expires = new Date(Date.now() + 15 * 60 * 1000);
                await supabase.from('partner_magic_links').insert({ person_id: person.id, token_hash: sha256(token), expires_at: expires.toISOString() });
                const magicUrl = `${process.env.SITE_URL || 'https://portal.mypayprotec.com'}/partner?magic=${token}`;
                await sendMagicEmail(person, magicUrl);
                results.sent.push(person.full_name || person.id);
            }
            return res.status(200).json({ success: true, results });
        }

        if (action === 'logout') {
            const { token } = req.body;
            if (token) await supabase.from('partner_sessions').delete().eq('session_token', token);
            return res.status(200).json({ success: true });
        }

        if (action === 'send_invite') {
            const { person_id } = req.body;
            const { data: person } = await supabase.from('persons').select('id, full_name, email').eq('id', person_id).single();
            if (!person?.email) return res.status(400).json({ success: false, message: 'Person has no email address.' });
            const inviteToken = generateToken(32);
            const expires = new Date(Date.now() + 72 * 60 * 60 * 1000);
            await supabase.from('persons').update({ portal_invite_token: inviteToken, invite_expires_at: expires.toISOString(), is_portal_active: true }).eq('id', person_id);
            const inviteUrl = `${process.env.SITE_URL || 'https://portal.mypayprotec.com'}/partner?token=${inviteToken}`;
            console.log(`[PARTNER INVITE] ${person.full_name} <${person.email}> -> ${inviteUrl}`);
            // Send via Postmark
            if (process.env.POSTMARK_SERVER_TOKEN) {
                try {
                    const { ServerClient } = await import('postmark');
                    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                    await client.sendEmail({
                        From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
                        To: person.email,
                        Subject: "You've been invited to the PayProTec Partner Portal",
                        HtmlBody: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;border:1px solid #e2e8f0;border-radius:16px;">
                            <img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:36px;margin-bottom:24px;display:block;">
                            <h2 style="color:#001e3c;font-size:22px;margin-bottom:8px;">Welcome to your Partner Portal</h2>
                            <p style="color:#475569;line-height:1.6;margin-bottom:24px;">Hi <strong>${person.full_name}</strong>, you've been invited to access the PayProTec Partner Portal — your dedicated dashboard for tracking your merchant portfolio, volumes, and more.</p>
                            <div style="text-align:center;margin:28px 0;">
                                <a href="${inviteUrl}" style="display:inline-block;padding:14px 32px;background:#0d9488;color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">Set Up My Account →</a>
                            </div>
                            <p style="color:#94a3b8;font-size:12px;line-height:1.5;">This link expires in 72 hours. If you didn't expect this, you can safely ignore it.</p>
                            <hr style="border:0;border-top:1px solid #f1f5f9;margin:24px 0;">
                            <p style="font-size:11px;color:#94a3b8;text-align:center;">PayProTec Partner Portal · Secure Access</p>
                        </div>`,
                        TextBody: `Hi ${person.full_name}, you've been invited to the PayProTec Partner Portal. Set up your account: ${inviteUrl}`,
                        MessageStream: 'outbound'
                    });
                } catch(emailErr) {
                    console.error('[PARTNER INVITE] Email failed:', emailErr.message);
                }
            }
            return res.status(200).json({ success: true, invite_url: inviteUrl });
        }

        // ── VERIFY INVITE TOKEN (check token is valid before showing form) ──
        if (action === 'verify_invite_token') {
            const { token } = req.body;
            if (!token) return res.status(400).json({ success: false, message: 'No token provided.' });

            const { data: person } = await supabase
                .from('persons')
                .select('id, full_name, invite_expires_at, portal_password_set')
                .eq('portal_invite_token', token)
                .single();

            if (!person) return res.status(400).json({ success: false, message: 'This invite link is invalid or has already been used.' });
            if (new Date(person.invite_expires_at) < new Date()) {
                return res.status(400).json({ success: false, message: 'This invite link has expired (72 hours). Please contact your PayProTec representative for a new one.' });
            }
            if (person.portal_password_set) {
                return res.status(400).json({ success: false, message: 'This invite link has already been used. Please sign in at the login page.' });
            }

            return res.status(200).json({ success: true, name: person.full_name });
        }

        if (action === 'setup_password') {
            const { token, password } = req.body;
            if (!token || !password) return res.status(400).json({ success: false, message: 'Missing token or password.' });
            if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email, portal_invite_token, invite_expires_at').eq('portal_invite_token', token).single();
            if (!person) return res.status(400).json({ success: false, message: 'Invalid or expired invite link.' });
            if (new Date(person.invite_expires_at) < new Date()) return res.status(400).json({ success: false, message: 'This invite link has expired. Please contact your administrator.' });
            await supabase.from('persons').update({ password_hash: await hashPassword(password), portal_password_set: true, portal_invite_token: null, invite_expires_at: null, is_portal_active: true }).eq('id', person.id);
            const sessionToken = await createSession(person.id, req);
            return res.status(200).json({ success: true, token: sessionToken, partner: { id: person.id, name: person.full_name, email: person.email } });
        }

        if (action === 'change_password') {
            const { token, current_password, new_password } = req.body;
            if (!token || !current_password || !new_password) {
                return res.status(400).json({ success: false, message: 'Missing required fields.' });
            }
            // Derive the partner from the validated session — never trust an id from the body.
            const partner_id = await validateSession(token);
            if (!partner_id) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.', reason: 'invalid_token' });

            // Get current hash
            const { data: person, error: fetchErr } = await supabase
                .from('persons')
                .select('password_hash')
                .eq('id', partner_id)
                .single();

            if (fetchErr || !person) {
                return res.status(400).json({ success: false, message: 'Partner not found.' });
            }

            // Verify current password
            if (!await verifyPassword(current_password, person.password_hash)) {
                return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
            }

            // Hash new password
            const newHash = await hashPassword(new_password);

            const { error: updateErr } = await supabase
                .from('persons')
                .update({ password_hash: newHash, portal_password_set: true })
                .eq('id', partner_id);

            if (updateErr) return res.status(400).json({ success: false, message: updateErr.message });
            return res.status(200).json({ success: true });
        }

        if (action === 'forgot_password') {
            const { email } = req.body;
            const { data: person } = await supabase.from('persons').select('id, full_name, email, is_portal_active').eq('email', (email || '').toLowerCase().trim()).single();
            if (person && person.is_portal_active) {
                const resetToken = generateToken(32);
                await supabase.from('persons').update({ portal_invite_token: resetToken, invite_expires_at: new Date(Date.now() + 3600000).toISOString() }).eq('id', person.id);
                const resetUrl = `${process.env.SITE_URL || 'https://portal.mypayprotec.com'}/partner?token=${resetToken}&mode=reset`;
                console.log(`[PASSWORD RESET] ${person.email} -> ${resetUrl}`);
                if (process.env.POSTMARK_SERVER_TOKEN) {
                    try {
                        const { ServerClient } = await import('postmark');
                        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                        await client.sendEmail({
                            From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
                            To: person.email,
                            Subject: 'Reset your PayProTec Partner Portal password',
                            HtmlBody: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;border:1px solid #e2e8f0;border-radius:16px;"><img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:36px;margin-bottom:24px;display:block;"><h2 style="color:#001e3c;">Password Reset Request</h2><p style="color:#475569;line-height:1.6;">Hi <strong>${person.full_name}</strong>, click the button below to reset your password. This link expires in 1 hour.</p><div style="text-align:center;margin:28px 0;"><a href="${resetUrl}" style="display:inline-block;padding:14px 32px;background:#0d9488;color:white;border-radius:10px;text-decoration:none;font-weight:700;">Reset My Password →</a></div><p style="color:#94a3b8;font-size:12px;">If you didn't request this, you can safely ignore it.</p></div>`,
                            TextBody: `Hi ${person.full_name}, reset your password: ${resetUrl}`,
                            MessageStream: 'outbound'
                        });
                    } catch(emailErr) { console.error('[RESET EMAIL] Failed:', emailErr.message); }
                }
            }
            return res.status(200).json({ success: true });
        }

        // ── TOGGLE PORTAL ACCESS (single or bulk) ────────────────────────────
        if (action === 'toggle_portal') {
            const { person_id, person_ids, active } = req.body;
            if (typeof active !== 'boolean') return res.status(400).json({ success: false, message: 'active (boolean) required' });
            if (person_ids && Array.isArray(person_ids)) {
                await supabase.from('persons').update({ is_portal_active: active }).in('id', person_ids);
                if (!active) {
                    // Kill all active sessions for these users
                    await supabase.from('partner_sessions').delete().in('person_id', person_ids);
                }
                return res.status(200).json({ success: true, updated: person_ids.length });
            }
            if (!person_id) return res.status(400).json({ success: false, message: 'person_id required' });
            await supabase.from('persons').update({ is_portal_active: active }).eq('id', person_id);
            if (!active) {
                await supabase.from('partner_sessions').delete().eq('person_id', person_id);
            }
            return res.status(200).json({ success: true });
        }

        // ── BULK INVITE ───────────────────────────────────────────────────────
        if (action === 'bulk_invite') {
            const { person_ids } = req.body;
            if (!Array.isArray(person_ids) || person_ids.length === 0) {
                return res.status(400).json({ success: false, message: 'person_ids array required' });
            }
            const { data: persons } = await supabase.from('persons').select('id, full_name, email').in('id', person_ids);
            if (!persons?.length) return res.status(400).json({ success: false, message: 'No persons found.' });

            const results = { sent: [], skipped: [], failed: [] };
            for (const person of persons) {
                if (!person.email) { results.skipped.push(person.full_name); continue; }
                try {
                    const inviteToken = generateToken(32);
                    const expires = new Date(Date.now() + 72 * 60 * 60 * 1000);
                    await supabase.from('persons').update({ portal_invite_token: inviteToken, invite_expires_at: expires.toISOString(), is_portal_active: true }).eq('id', person.id);
                    const inviteUrl = `${process.env.SITE_URL || 'https://portal.mypayprotec.com'}/partner?token=${inviteToken}`;
                    if (process.env.POSTMARK_SERVER_TOKEN) {
                        const { ServerClient } = await import('postmark');
                        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                        await client.sendEmail({
                            From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
                            To: person.email,
                            Subject: "You've been invited to the PayProTec Partner Portal",
                            HtmlBody: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;border:1px solid #e2e8f0;border-radius:16px;">
                                <img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:36px;margin-bottom:24px;display:block;">
                                <h2 style="color:#001e3c;font-size:22px;margin-bottom:8px;">Welcome to your Partner Portal</h2>
                                <p style="color:#475569;line-height:1.6;margin-bottom:24px;">Hi <strong>${person.full_name}</strong>, you've been invited to access the PayProTec Partner Portal — your dedicated dashboard for tracking your merchant portfolio, volumes, and more.</p>
                                <div style="text-align:center;margin:28px 0;">
                                    <a href="${inviteUrl}" style="display:inline-block;padding:14px 32px;background:#0d9488;color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">Set Up My Account →</a>
                                </div>
                                <p style="color:#94a3b8;font-size:12px;line-height:1.5;">This link expires in 72 hours. If you didn't expect this, you can safely ignore it.</p>
                            </div>`,
                            TextBody: `Hi ${person.full_name}, you've been invited to the PayProTec Partner Portal. Set up your account: ${inviteUrl}`,
                            MessageStream: 'outbound'
                        });
                    }
                    results.sent.push(person.full_name);
                } catch(e) {
                    results.failed.push(person.full_name);
                }
            }
            return res.status(200).json({ success: true, results });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });

    } catch (err) {
        console.error('Partner Auth Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
}
