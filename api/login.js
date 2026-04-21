import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { ServerClient } from 'postmark';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { email, passkey, userId, action, deviceToken, code, remember } = req.body;

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    try {
        let user = null;
        let error = null;
        let generatedDeviceToken = null;

        // --- ACTION: FORGOT PASSWORD ---
        if (action === 'forgotPassword') {
            const { data: resetUser } = await supabase
                .from('app_users')
                .select('userid, first_name, email')
                .eq('email', email)
                .single();

            if (resetUser) {
                const resetToken = crypto.randomUUID();
                await supabase.from('app_users').update({
                    invitation_token: resetToken,
                    is_active: false
                }).eq('userid', resetUser.userid);

                if (process.env.POSTMARK_SERVER_TOKEN) {
                    const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                    const setupUrl = `https://${req.headers.host}/setup-password.html?token=${resetToken}`;
                    await client.sendEmail({
                        "From": process.env.EMAIL_FROM,
                        "To": resetUser.email,
                        "Subject": "Reset your PayProtec Portal Password",
                        "HtmlBody": `<div style="font-family: sans-serif; padding: 20px;"><h2>Password Reset</h2><p>Click below to set a new password:</p><a href="${setupUrl}">${setupUrl}</a></div>`,
                        "MessageStream": "outbound"
                    });
                }
            }
            return res.status(200).json({ success: true });
        }

        // --- ACTION: VALIDATE SESSION ---
        else if (action === 'validate') {
            const { data, error: valError } = await supabase
                .from('app_users')
                .select('*')
                .eq('userid', userId)
                .single();
            user = data;
            error = valError;
        }

        // --- ACTION: VERIFY 2FA CODE ---
       else if (action === 'verify2FA') {
    const { data: tfaUser } = await supabase.from('app_users').select('*').eq('userid', userId).single();

    if (tfaUser && tfaUser.tfa_code === code) {
        if (remember) {
            // Check if we already have a token for this user in this session
            // though usually, 2FA means we need a BRAND NEW one.
            generatedDeviceToken = crypto.randomUUID();
            
            await supabase.from('trusted_devices').insert({
                userid: userId,
                device_token: generatedDeviceToken,
                last_used: new Date().toISOString(),
                expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            });
        }
                
                await supabase.from('app_users').update({ tfa_code: null }).eq('userid', userId);
                user = tfaUser;
            } else {
                return res.status(401).json({ success: false, message: 'Invalid verification code.' });
            }
        }

        // --- ACTION: INITIAL LOGIN ---
        else if (action === 'login') {
            const { data: dbUser, error: fetchError } = await supabase
                .from('app_users')
                .select('*')
                .eq('email', email)
                .single();

            if (fetchError || !dbUser) {
                error = { message: 'User not found' };
            } else {
                if (!dbUser.is_active) return res.status(401).json({ success: false, message: 'Account not activated.' });

                const isMatch = bcrypt.compareSync(passkey, dbUser.password_hash);
              if (isMatch) {
    // 1. Get token from request body
    const sentToken = req.body.deviceToken; 

    // 2. Query trusted devices
    const { data: trusted, error: trustedError } = await supabase
        .from('trusted_devices')
        .select('*')
        .eq('userid', dbUser.userid)
        .eq('device_token', sentToken) // If sentToken is null, this naturally fails
        .gt('expires_at', new Date().toISOString())
        .maybeSingle(); // Use maybeSingle to avoid 406 errors

    if (trusted && !trustedError) {
        // SUCCESS: Device recognized.
        user = dbUser;
    } else {
        // NEW DEVICE: Trigger 2FA
        const tfaCode = Math.floor(100000 + Math.random() * 900000).toString();
                        await supabase.from('app_users').update({ tfa_code: tfaCode }).eq('userid', dbUser.userid);

                        if (process.env.POSTMARK_SERVER_TOKEN) {
                            const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                            await client.sendEmail({
                                "From": process.env.EMAIL_FROM,
                                "To": dbUser.email,
                                "Subject": `${tfaCode} is your PayProtec access code`,
                                "HtmlBody": `<div style="font-family:sans-serif; padding:20px;"><h2>Verification Required</h2><p>Your code: <h1 style="letter-spacing:5px; text-align:center;">${tfaCode}</h1></p></div>`
                            });
                        }
                        return res.status(200).json({ success: true, needs2FA: true, userid: dbUser.userid });
                    }
                } else {
                    error = { message: 'Invalid password' };
                }
            }
        }

        // --- LOG ACTIVITY ---
        await supabase.from('activity_logs').insert([{
            email: email || (user ? user.email : 'Unknown'),
            action: action,
            status: (!error && user) ? 'SUCCESS' : 'FAILURE',
            user_agent: req.headers['user-agent'],
            ip_address: req.headers['x-forwarded-for'] || 'Internal'
        }]);

        if (error || !user) {
            return res.status(401).json({ success: false, message: error?.message || 'Authentication failed' });
        }

        // --- RETURN CLEAN OBJECT ---
        const cleanUser = {
            userid: user.userid,
            first_name: user.first_name,
            email: user.email,
            role: user.role,
            access_inventory: user.access_inventory,
            access_deployments: user.access_deployments,
            access_returns: user.access_returns,
            access_merchants: user.access_merchants
        };

        return res.status(200).json({
            success: true,
            user: cleanUser,
            newDeviceToken: generatedDeviceToken // Correctly sends the token back
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
}
