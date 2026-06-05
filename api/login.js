import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { ServerClient } from 'postmark';

async function createStaffSession(supabase, userid, req) {
    const { data } = await supabase.from('staff_sessions').insert({
        userid,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        user_agent: req.headers['user-agent'] || null,
        ip_address: req.headers['x-forwarded-for'] || 'Internal'
    }).select('session_token').single();
    return data?.session_token || null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { email, passkey, userId, action, deviceToken, code, remember } = req.body;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        let user = null;
        let error = null;
        let generatedDeviceToken = null;
        let generatedSessionToken = null;

        // --- FORGOT PASSWORD ---
        if (action === 'forgotPassword') {
            const { data: resetUser } = await supabase.from('app_users').select('userid, first_name, email').eq('email', email).single();
            if (resetUser) {
                const resetToken = crypto.randomUUID();
                // Only set the reset token — do NOT set is_active: false.
                // Deactivating the account lets anyone with a known email lock a colleague out.
                await supabase.from('app_users').update({ invitation_token: resetToken }).eq('userid', resetUser.userid);
                if (process.env.POSTMARK_SERVER_TOKEN) {
                    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                    const setupUrl = `https://${req.headers.host}/setup-password.html?token=${resetToken}`;
                    await client.sendEmail({
                        "From": process.env.EMAIL_FROM, "To": resetUser.email, "Subject": "Reset Password",
                        "HtmlBody": `<p>Reset link: <a href="${setupUrl}">${setupUrl}</a></p>`
                    });
                }
            }
            return res.status(200).json({ success: true });
        }

        // --- FORCE CHANGE PASSWORD (temp password flow — no session required) ---
        if (action === 'force_change_password') {
            const { userid, change_token, new_password } = req.body;
            if (!userid || !change_token || !new_password) return res.status(400).json({ success: false, message: 'Missing required fields.' });
            if (new_password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });

            // Verify change token matches and flag is still set
            const { data: targetUser } = await supabase.from('app_users')
                .select('*').eq('userid', userid).eq('needs_password_change', true).eq('invitation_token', change_token).single();
            if (!targetUser) return res.status(401).json({ success: false, message: 'Invalid or expired token. Please log in again.' });

            const hashed = bcrypt.hashSync(new_password, 12);
            await supabase.from('app_users').update({
                password_hash: hashed,
                passkey: hashed,
                needs_password_change: false,
                invitation_token: null,
                is_active: true,
                last_seen: new Date().toISOString()
            }).eq('userid', userid);

            // Create real session now
            const sessionToken = await createStaffSession(supabase, userid, req);
            const { data: freshUser } = await supabase.from('app_users').select('*').eq('userid', userid).single();

            await supabase.from('activity_logs').insert([{
                email: targetUser.email, action: 'Forced password change completed — new session created',
                status: 'SUCCESS', category: 'auth', severity: 'info',
                user_agent: req.headers['user-agent'], ip_address: req.headers['x-forwarded-for'] || 'Internal'
            }]);

            return res.status(200).json({ success: true, user: freshUser, session_token: sessionToken });
        }

        // --- LOGOUT (invalidate session token) ---
        else if (action === 'logout') {
            const authHeader = req.headers['authorization'];
            if (authHeader?.startsWith('Bearer ')) {
                const token = authHeader.slice(7).trim();
                await supabase.from('staff_sessions').delete().eq('session_token', token);
            }
            return res.status(200).json({ success: true });
        }

        // --- VALIDATE (requires valid session token) ---
        else if (action === 'validate') {
            const authHeader = req.headers['authorization'];
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({ success: false, message: 'No session. Please log in.', reason: 'no_token' });
            }
            const token = authHeader.slice(7).trim();
            const { data: session } = await supabase.from('staff_sessions')
                .select('userid, expires_at').eq('session_token', token).maybeSingle();
            if (!session || new Date(session.expires_at) < new Date()) {
                if (session) await supabase.from('staff_sessions').delete().eq('session_token', token);
                return res.status(401).json({ success: false, message: 'Session expired.', reason: 'session_expired' });
            }
            // Refresh last_used (fire-and-forget)
            supabase.from('staff_sessions').update({ last_used: new Date().toISOString() }).eq('session_token', token);
            const { data, error: valError } = await supabase.from('app_users').select('*').eq('userid', session.userid).single();
            // If admin set a temp password while user was already logged in, force them back to login
            if (data?.needs_password_change) {
                await supabase.from('staff_sessions').delete().eq('session_token', token);
                return res.status(401).json({ success: false, reason: 'password_change_required', message: 'Your password has been reset. Please log in again.' });
            }
            user = data;
            error = valError;
        }

        // --- VERIFY 2FA ---
        else if (action === 'verify2FA') {
            const { data: tfaUser } = await supabase.from('app_users').select('*').eq('userid', userId).single();

            const attempts = (tfaUser?.tfa_attempts || 0) + 1;
            const MAX_ATTEMPTS = 5;

            if (!tfaUser || !tfaUser.tfa_code) {
                return res.status(401).json({ success: false, message: 'No active verification code. Please log in again.' });
            }

            if (tfaUser.tfa_attempts >= MAX_ATTEMPTS) {
                await supabase.from('app_users').update({ tfa_code: null, tfa_attempts: 0 }).eq('userid', userId);
                return res.status(429).json({ success: false, message: 'Too many failed attempts. Please log in again.' });
            }

            if (tfaUser.tfa_code && await bcrypt.compare(code, tfaUser.tfa_code)) {
                if (remember) {
                    generatedDeviceToken = crypto.randomUUID();
                    await supabase.from('trusted_devices').insert({
                        userid: userId, device_token: generatedDeviceToken,
                        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                    });
                }
                await supabase.from('app_users').update({ tfa_code: null, tfa_attempts: 0, last_seen: new Date().toISOString() }).eq('userid', userId);
                user = tfaUser;
                generatedSessionToken = await createStaffSession(supabase, userId, req);
            } else {
                await supabase.from('app_users').update({ tfa_attempts: attempts }).eq('userid', userId);
                const remaining = MAX_ATTEMPTS - attempts;
                return res.status(401).json({ success: false, message: remaining > 0 ? `Invalid code. ${remaining} attempt(s) remaining.` : 'Too many failed attempts. Please log in again.' });
            }
        }

        // --- LOGIN ---
        else if (action === 'login') {
            // Rate limit: block after 5 failed login attempts within 15 minutes
            const windowStart = new Date(Date.now() - 15 * 60 * 1000).toISOString();
            const { count: recentFailures } = await supabase
                .from('activity_logs')
                .select('*', { count: 'exact', head: true })
                .eq('email', email)
                .eq('action', 'login')
                .eq('status', 'FAILURE')
                .gte('created_at', windowStart);
            if (recentFailures >= 5) {
                return res.status(429).json({ success: false, message: 'Too many failed login attempts. Please wait 15 minutes and try again.' });
            }

            const { data: dbUser, error: fetchError } = await supabase.from('app_users').select('*').eq('email', email).single();
            if (fetchError || !dbUser) {
                error = { message: 'User not found' };
            } else {
                if (!dbUser.is_active) return res.status(401).json({ success: false, message: 'Account not activated.' });
                if (bcrypt.compareSync(passkey, dbUser.password_hash)) {

                    // ── Force password change if admin set a temp password ──
                    if (dbUser.needs_password_change) {
                        const changeToken = crypto.randomUUID();
                        await supabase.from('app_users').update({ invitation_token: changeToken }).eq('userid', dbUser.userid);
                        await supabase.from('activity_logs').insert([{
                            email: dbUser.email, action: 'Login with temp password — password change required',
                            status: 'SUCCESS', category: 'auth', severity: 'warning',
                            user_agent: req.headers['user-agent'], ip_address: req.headers['x-forwarded-for'] || 'Internal'
                        }]);
                        return res.status(200).json({ success: true, needs_password_change: true, change_token: changeToken, userid: dbUser.userid });
                    }

                    const sentToken = (deviceToken && deviceToken !== "null") ? deviceToken : null;
                    let trusted = null;

                    if (sentToken) {
                        const { data } = await supabase.from('trusted_devices')
                            .select('*')
                            .eq('userid', dbUser.userid)
                            .eq('device_token', sentToken)
                            .gt('expires_at', new Date().toISOString())
                            .maybeSingle();
                        trusted = data;
                    }

                    if (trusted) {
                        await supabase.from('trusted_devices').update({ last_used: new Date().toISOString() }).eq('id', trusted.id);
                        await supabase.from('app_users').update({ last_seen: new Date().toISOString() }).eq('userid', dbUser.userid);
                        user = dbUser;
                        generatedSessionToken = await createStaffSession(supabase, dbUser.userid, req);
                    } else {
                        const tfaCode = Math.floor(100000 + Math.random() * 900000).toString();
                        const tfaHash = await bcrypt.hash(tfaCode, 10);
                        await supabase.from('app_users').update({ tfa_code: tfaHash, tfa_attempts: 0 }).eq('userid', dbUser.userid);
                        if (process.env.POSTMARK_SERVER_TOKEN) {
                            const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                            await client.sendEmail({
                                "From": process.env.EMAIL_FROM, "To": dbUser.email, "Subject": `${tfaCode} Access Code`,
                                "HtmlBody": `
    <div style="font-family: 'Inter', Arial, sans-serif; max-width: 450px; margin: auto; padding: 40px; border: 1px solid #e2e8f0; border-radius: 24px; color: #1e293b; background-color: #ffffff; text-align: center;">
        <h2 style="color: #004990; margin-bottom: 10px;">Security Verification</h2>
        <p style="font-size: 15px; color: #64748b; margin-bottom: 30px;">A login attempt was made from a new device. Use the code below to authorize access:</p>

        <div style="background-color: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 12px; padding: 20px; margin-bottom: 30px;">
            <h1 style="font-size: 36px; letter-spacing: 8px; color: #004990; margin: 0; font-family: monospace;">${tfaCode}</h1>
        </div>

        <p style="font-size: 12px; color: #94a3b8;">If you did not request this, please change your password immediately.</p>
        <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 30px 0;">
        <p style="font-size: 11px; color: #94a3b8;">PayProTec Hardware Management Console</p>
    </div>
`
                            });
                        }
                        return res.status(200).json({ success: true, needs2FA: true, userid: dbUser.userid });
                    }
                } else { error = { message: 'Invalid password' }; }
            }
        }

        // --- LOG ACTIVITY ---
        await supabase.from('activity_logs').insert([{
            email: email || (user ? user.email : 'Unknown'),
            action: action, status: (!error && user) ? 'SUCCESS' : 'FAILURE',
            user_agent: req.headers['user-agent'], ip_address: req.headers['x-forwarded-for'] || 'Internal'
        }]);

        if (error || !user) return res.status(401).json({ success: false, message: error?.message || 'Auth failed' });

        return res.status(200).json({
            success: true,
            sessionToken: generatedSessionToken,
            user: {
                userid: user.userid, first_name: user.first_name, last_name: user.last_name,
                email: user.email, role: user.role,
                access_inventory: user.access_inventory, access_deployments: user.access_deployments,
                access_returns: user.access_returns, access_merchants: user.access_merchants,
                access_partners: user.access_partners,
                access_jarvis: user.access_jarvis,
                access_admin_dashboard: user.access_admin_dashboard,
                access_sending_reports: user.access_sending_reports,
                can_delete_tickets: user.can_delete_tickets
            },
            newDeviceToken: generatedDeviceToken
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
}
