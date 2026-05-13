import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { ServerClient } from 'postmark';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    try {
        if (req.method === 'GET' || req.query.action === 'list') {
            // Only return non-sensitive fields
            const { data, error } = await supabase.from('app_users')
                .select('userid,id,first_name,last_name,email,role,is_active,last_seen,access_admin_dashboard,access_merchants,access_deployments,access_returns,access_inventory,access_reports,access_tickets,access_partners,access_community,access_tasks,can_delete_tickets,created_at')
                .order('first_name');
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (req.method === 'POST') {
            const { action, payload, userid, performerRole } = req.body;

            if (action === 'insert') {
                // RULE 1: Only super_admin can create super_admin — verify role from DB, not client
                if (payload.role === 'super_admin') {
                    const { data: performer } = await supabase.from('app_users').select('role').eq('userid', userid).single();
                    if (!performer || performer.role !== 'super_admin') {
                        return res.status(403).json({ success: false, message: 'Only Super Admins can grant God Mode.' });
                    }
                }

                const invitationToken = crypto.randomUUID();
                const newUser = {
                    ...payload,
                    invitation_token: invitationToken,
                    is_active: false,
                    passkey: 'PENDING_SETUP'
                };

                const { error: insertError } = await supabase.from('app_users').insert([newUser]);

                if (insertError) {
                    if (insertError.code === '23505') return res.status(400).json({ success: false, message: 'User already exists.' });
                    throw insertError;
                }

                // Email Trigger
                let emailSent = false;
                if (process.env.POSTMARK_SERVER_TOKEN) {
                    try {
                        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                        const setupUrl = `https://${req.headers.host}/setup-password.html?token=${invitationToken}`;
                        await client.sendEmail({
                            "From": process.env.EMAIL_FROM,
                            "To": payload.email,
                            "Subject": "Action Required: Set up your PayProtec Staff Portal account",
                            "HtmlBody": `
        <div style="font-family: 'Inter', Arial, sans-serif; max-width: 500px; margin: auto; padding: 30px; border: 1px solid #e2e8f0; border-radius: 16px; color: #1e293b; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 20px;">
                <h2 style="color: #004990; margin: 0; font-size: 24px;">PayProTec Portal</h2>
            </div>
            <h1 style="color: #004990; font-size: 20px; margin-bottom: 20px;">Welcome, ${payload.first_name}!</h1>
            <p style="line-height: 1.6;">An account has been created for you on the <strong>Hardware Management Portal</strong>.</p>
            <p style="line-height: 1.6;">To finalize your access and secure your account, please click the button below to set your password:</p>

            <div style="text-align: center; margin: 35px 0;">
                <a href="${setupUrl}" style="background-color: #004990; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Set Up My Password</a>
            </div>

            <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
                If the button does not work, copy and paste this link into your browser:<br>
                <a href="${setupUrl}" style="color: #004990; word-break: break-all;">${setupUrl}</a>
            </p>

            <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 30px 0;">
            <p style="font-size: 11px; color: #94a3b8; text-align: center;">This is an automated security message from PayProTec Operations. Please do not reply to this email.</p>
        </div>
    `,
                            "TextBody": `Welcome ${payload.first_name}! Set up your account here: ${setupUrl}`,
                            "MessageStream": "outbound"
                        });
                        emailSent = true;
                    } catch (e) {
                        console.error("Email failed", e);
                    }
                }
                return res.status(200).json({ success: true, email_sent: emailSent });
            } 
            
            if (action === 'updateBatch') {
                // Whitelist allowed fields — prevent role/credential escalation via this endpoint
                const ALLOWED_BATCH_FIELDS = [
                    'first_name','last_name','email','role','is_active',
                    'access_admin_dashboard','access_merchants','access_deployments',
                    'access_returns','access_inventory','access_reports',
                    'access_tickets','access_partners','access_community',
                    'access_tasks','can_delete_tickets'
                ];
                for (const uid of Object.keys(payload)) {
                    const safePayload = Object.fromEntries(
                        Object.entries(payload[uid]).filter(([k]) => ALLOWED_BATCH_FIELDS.includes(k))
                    );
                    if (Object.keys(safePayload).length > 0) {
                        await supabase.from('app_users').update(safePayload).eq('userid', uid);
                    }
                }
                return res.status(200).json({ success: true });
            }

            if (action === 'resend_invite') {
                const { userid } = req.body;
                const { data: user } = await supabase.from('app_users').select('first_name, email, invitation_token').eq('userid', userid).single();
                if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
                
                // Generate new token
                const newToken = crypto.randomUUID();
                await supabase.from('app_users').update({ invitation_token: newToken }).eq('userid', userid);

                const setupUrl = `https://${req.headers.host}/setup-password.html?token=${newToken}`;

                let emailSent = false;
                if (process.env.POSTMARK_SERVER_TOKEN) {
                    try {
                        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                        await client.sendEmail({
                            "From": process.env.EMAIL_FROM,
                            "To": user.email,
                            "Subject": "Reminder: Set up your PayProTec Staff Portal account",
                            "HtmlBody": `<div style="font-family:sans-serif;max-width:500px;margin:auto;padding:30px;"><h2 style="color:#004990;">PayProTec Portal</h2><p>Hi ${user.first_name}, your account setup link has been refreshed. Click below to set your password:</p><div style="text-align:center;margin:30px 0;"><a href="${setupUrl}" style="background:#004990;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:bold;">Set Up My Password</a></div><p style="font-size:12px;color:#64748b;">${setupUrl}</p></div>`,
                            "TextBody": `Set up your account: ${setupUrl}`,
                            "MessageStream": "outbound"
                        });
                        emailSent = true;
                    } catch(e) { console.error("Email failed", e); }
                }
                return res.status(200).json({ success: true, setup_url: setupUrl, email_sent: emailSent });
            } 
            
            if (action === 'delete') {
                const { error } = await supabase.from('app_users').delete().eq('userid', userid);
                if (error) throw error;
                return res.status(200).json({ success: true });
            }

            if (action === 'change_password') {
                const { userid: uid, current_password, new_password } = req.body;
                if (!current_password || !new_password) return res.status(400).json({ success: false, message: 'Both passwords required.' });
                if (new_password.length < 8) return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });

                // Get current passkey
                const { data: user } = await supabase.from('app_users').select('passkey, first_name').eq('userid', uid).single();
                if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

                // Verify current password using bcrypt
                const passwordValid = await bcrypt.compare(current_password, user.passkey)
                    || await bcrypt.compare(current_password, user.password_hash || '');
                if (!passwordValid) {
                    return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
                }

                // Save new password as bcrypt hash
                const newHash = await bcrypt.hash(new_password, 12);
                await supabase.from('app_users').update({ passkey: newHash, password_hash: newHash }).eq('userid', uid);

                // Log it
                await supabase.from('activity_logs').insert({
                    email: uid, action: 'Changed own password',
                    status: 'success', category: 'auth', severity: 'info'
                });

                return res.status(200).json({ success: true });
            }
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
