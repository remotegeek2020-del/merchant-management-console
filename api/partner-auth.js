import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function hashPassword(password) {
    return crypto.createHash('sha256').update(password + (process.env.PARTNER_SALT || 'pp_partner_2024')).digest('hex');
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
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).single();
    if (!data) return null;
    if (new Date(data.expires_at) < new Date()) {
        await supabase.from('partner_sessions').delete().eq('session_token', token);
        return null;
    }
    return data.person_id;
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

        if (action === 'login') {
            const { email, password } = req.body;
            if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required.' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email, is_portal_active, password_hash, portal_password_set').eq('email', email.toLowerCase().trim()).single();
            if (!person) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
            if (!person.is_portal_active) return res.status(403).json({ success: false, message: 'Your portal access is not yet activated. Check your email for an invite.' });
            if (!person.portal_password_set) return res.status(403).json({ success: false, message: 'Please complete your account setup using the invite link sent to your email.' });
            if (hashPassword(password) !== person.password_hash) return res.status(401).json({ success: false, message: 'Invalid credentials.' });
            const token = await createSession(person.id, req);
            await supabase.from('persons').update({ last_portal_login: new Date().toISOString() }).eq('id', person.id);
            return res.status(200).json({ success: true, token, partner: { id: person.id, name: person.full_name, email: person.email } });
        }

        if (action === 'validate') {
            const { token } = req.body;
            const personId = await validateSession(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email, is_portal_active').eq('id', personId).single();
            if (!person || !person.is_portal_active) return res.status(401).json({ success: false });
            const identifiers = await getPartnerAgentIds(personId);
            return res.status(200).json({ success: true, partner: { id: person.id, name: person.full_name, email: person.email }, identifiers });
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
            const inviteUrl = `${process.env.SITE_URL || 'https://portal.mypayprotec.com'}/partner/setup.html?token=${inviteToken}`;
            console.log(`[PARTNER INVITE] ${person.full_name} <${person.email}> -> ${inviteUrl}`);
            if (process.env.RESEND_API_KEY) {
                await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        from: 'PayProTec Partner Portal <noreply@mypayprotec.com>',
                        to: person.email,
                        subject: "You've been invited to the PayProTec Partner Portal",
                        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;"><img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:36px;margin-bottom:24px;"><h2 style="color:#001e3c;">Welcome to your Partner Portal</h2><p style="color:#475569;line-height:1.6;">Hi ${person.full_name}, you've been invited to access the PayProTec Partner Portal — your dedicated dashboard for tracking your merchant portfolio.</p><a href="${inviteUrl}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#0d9488;color:white;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;">Set Up My Account</a><p style="color:#94a3b8;font-size:12px;">This link expires in 72 hours.</p></div>`
                    })
                });
            }
            return res.status(200).json({ success: true, invite_url: inviteUrl });
        }

        if (action === 'setup_password') {
            const { token, password } = req.body;
            if (!token || !password) return res.status(400).json({ success: false, message: 'Missing token or password.' });
            if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
            const { data: person } = await supabase.from('persons').select('id, full_name, email, portal_invite_token, invite_expires_at').eq('portal_invite_token', token).single();
            if (!person) return res.status(400).json({ success: false, message: 'Invalid or expired invite link.' });
            if (new Date(person.invite_expires_at) < new Date()) return res.status(400).json({ success: false, message: 'This invite link has expired. Please contact your administrator.' });
            await supabase.from('persons').update({ password_hash: hashPassword(password), portal_password_set: true, portal_invite_token: null, invite_expires_at: null, is_portal_active: true }).eq('id', person.id);
            const sessionToken = await createSession(person.id, req);
            return res.status(200).json({ success: true, token: sessionToken, partner: { id: person.id, name: person.full_name, email: person.email } });
        }

        if (action === 'forgot_password') {
            const { email } = req.body;
            const { data: person } = await supabase.from('persons').select('id, full_name, email, is_portal_active').eq('email', (email || '').toLowerCase().trim()).single();
            if (person && person.is_portal_active) {
                const resetToken = generateToken(32);
                await supabase.from('persons').update({ portal_invite_token: resetToken, invite_expires_at: new Date(Date.now() + 3600000).toISOString() }).eq('id', person.id);
                const resetUrl = `${process.env.SITE_URL || 'https://portal.mypayprotec.com'}/partner/setup.html?token=${resetToken}&mode=reset`;
                console.log(`[PASSWORD RESET] ${person.email} -> ${resetUrl}`);
                if (process.env.RESEND_API_KEY) {
                    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'PayProTec Partner Portal <noreply@mypayprotec.com>', to: person.email, subject: 'Reset your Partner Portal password', html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;"><h2 style="color:#001e3c;">Password Reset</h2><p style="color:#475569;">Hi ${person.full_name}, click below to reset your password. This link expires in 1 hour.</p><a href="${resetUrl}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#0d9488;color:white;border-radius:10px;text-decoration:none;font-weight:700;">Reset Password</a></div>` }) });
                }
            }
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });

    } catch (err) {
        console.error('Partner Auth Error:', err.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
}
