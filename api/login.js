import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { ServerClient } from 'postmark';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { email, passkey, userId, action, deviceToken, code, remember } = req.body;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        let user = null;
        let error = null;
        let generatedDeviceToken = null;

        // --- FORGOT PASSWORD ---
        if (action === 'forgotPassword') {
            const { data: resetUser } = await supabase.from('app_users').select('userid, first_name, email').eq('email', email).single();
            if (resetUser) {
                const resetToken = crypto.randomUUID();
                await supabase.from('app_users').update({ invitation_token: resetToken, is_active: false }).eq('userid', resetUser.userid);
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

        // --- VALIDATE ---
        else if (action === 'validate') {
            const { data, error: valError } = await supabase.from('app_users').select('*').eq('userid', userId).single();
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

            if (tfaUser.tfa_code === code) {
                if (remember) {
                    generatedDeviceToken = crypto.randomUUID();
                    await supabase.from('trusted_devices').insert({
                        userid: userId, device_token: generatedDeviceToken,
                        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                    });
                }
                await supabase.from('app_users').update({ tfa_code: null, tfa_attempts: 0 }).eq('userid', userId);
                user = tfaUser;
            } else {
                await supabase.from('app_users').update({ tfa_attempts: attempts }).eq('userid', userId);
                const remaining = MAX_ATTEMPTS - attempts;
                return res.status(401).json({ success: false, message: remaining > 0 ? `Invalid code. ${remaining} attempt(s) remaining.` : 'Too many failed attempts. Please log in again.' });
            }
        }

        // --- LOGIN ---
        else if (action === 'login') {
            const { data: dbUser, error: fetchError } = await supabase.from('app_users').select('*').eq('email', email).single();
            if (fetchError || !dbUser) {
                error = { message: 'User not found' };
            } else {
                if (!dbUser.is_active) return res.status(401).json({ success: false, message: 'Account not activated.' });
                if (bcrypt.compareSync(passkey, dbUser.password_hash)) {
                    
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
                        user = dbUser;
                    } else {
                        const tfaCode = Math.floor(100000 + Math.random() * 900000).toString();
                        await supabase.from('app_users').update({ tfa_code: tfaCode, tfa_attempts: 0 }).eq('userid', dbUser.userid);
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
            user: {
                userid: user.userid, first_name: user.first_name, email: user.email, role: user.role,
                access_inventory: user.access_inventory, access_deployments: user.access_deployments,
                access_returns: user.access_returns, access_merchants: user.access_merchants,
                access_partners: user.access_partners, // Added for completeness
        access_jarvis: user.access_jarvis    // THIS IS THE CRITICAL ADDITION
            },
            newDeviceToken: generatedDeviceToken
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
}
