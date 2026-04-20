import { createClient } from '@supabase/supabase-js';
import { ServerClient } from 'postmark';
import crypto from 'crypto';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    try {
        if (req.method === 'GET' || req.query.action === 'list') {
            const { data, error } = await supabase.from('app_users').select('*').order('first_name');
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (req.method === 'POST') {
            const { action, payload, userid, performerRole } = req.body;

            if (action === 'insert') {
                // RULE 1: Only super_admin can create super_admin
                if (payload.role === 'super_admin' && performerRole !== 'super_admin') {
                    return res.status(403).json({ success: false, message: 'Only Super Admins can grant God Mode.' });
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
                if (process.env.POSTMARK_SERVER_TOKEN) {
                    try {
                        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                        const setupUrl = `https://${req.headers.host}/setup-password.html?token=${invitationToken}`;
                       // --- RESTORED PROFESSIONAL DESIGN ---
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
                    } catch (e) { console.error("Email failed", e); }
                }
                return res.status(200).json({ success: true });
            } 
            
            if (action === 'updateBatch') {
                for (const uid of Object.keys(payload)) {
                    await supabase.from('app_users').update(payload[uid]).eq('userid', uid);
                }
                return res.status(200).json({ success: true });
            } 
            
            if (action === 'delete') {
                const { error } = await supabase.from('app_users').delete().eq('userid', userid);
                if (error) throw error;
                return res.status(200).json({ success: true });
            }
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
