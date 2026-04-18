// api/users.js
import { createClient } from '@supabase/supabase-js';
import { ServerClient } from 'postmark';
import crypto from 'crypto';

export default async function handler(req, res) {
    // 1. Initialize Supabase with Service Role Key for administrative access
    const supabase = createClient(
        process.env.SUPABASE_URL, 
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    
    try {
        // --- HANDLE LISTING (GET) ---
        if (req.method === 'GET' || req.query.action === 'list') {
            const { data, error } = await supabase
                .from('app_users')
                .select('*')
                .order('first_name');

            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // --- HANDLE ACTIONS (POST) ---
        if (req.method === 'POST') {
            const { action, payload, userid } = req.body;

            // ACTION: ENROLL NEW USER
            if (action === 'insert') {
                const invitationToken = crypto.randomUUID();
                
                const newUser = {
                    // We omit 'userid' so the DB generates a UUID automatically via DEFAULT
                    ...payload,
                    invitation_token: invitationToken,
                    is_active: false, // Must remain false until setup-password.html is completed
                    passkey: 'PENDING_SETUP' // Placeholder for legacy field support
                };

                // Insert into Database
                const { error: insertError } = await supabase
                    .from('app_users')
                    .insert([newUser]);
                
                if (insertError) {
                    // Handle duplicate emails (Postgres error code 23505)
                    if (insertError.code === '23505') {
                        return res.status(400).json({ success: false, message: 'User with this email already exists.' });
                    }
                    return res.status(400).json({ success: false, message: insertError.message });
                }

                // --- POSTMARK EMAIL TRIGGER ---
                if (process.env.POSTMARK_SERVER_TOKEN) {
                    try {
                        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                        const protocol = req.headers['x-forwarded-proto'] || 'https';
                        const host = req.headers.host;
                        const setupUrl = `${protocol}://${host}/setup-password.html?token=${invitationToken}`;

                        await client.sendEmail({
                            "From": process.env.EMAIL_FROM,
                            "To": payload.email,
                            "Subject": "Action Required: Set up your PayProtec Staff Portal account",
                            "HtmlBody": `
                                <div style="font-family: 'Inter', sans-serif; max-width: 500px; margin: auto; padding: 30px; border: 1px solid #e2e8f0; border-radius: 16px; color: #1e293b;">
                                    <h1 style="color: #004990; font-size: 22px; margin-bottom: 20px;">Welcome, ${payload.first_name}!</h1>
                                    <p>An account has been created for you on the <strong>PayProtec Staff Portal</strong>.</p>
                                    <p>To finalize your access, please click the button below to set your password:</p>
                                    <div style="text-align: center; margin: 30px 0;">
                                        <a href="${setupUrl}" style="background-color: #004990; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Set Up My Password</a>
                                    </div>
                                    <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
                                        If the button does not work, copy and paste this link into your browser:<br>
                                        <span style="color: #004990;">${setupUrl}</span>
                                    </p>
                                    <hr style="border: 0; border-top: 1px solid #f1f5f9; margin: 30px 0;">
                                    <p style="font-size: 11px; color: #94a3b8; text-align: center;">This is an automated security message from PayProtec Operations.</p>
                                </div>
                            `,
                            "TextBody": `Welcome ${payload.first_name}! Set up your account here: ${setupUrl}`,
                            "MessageStream": "outbound"
                        });
                    } catch (mailErr) {
                        console.error("Postmark Delivery Error:", mailErr.message);
                        // We do not fail the request here because the user is already in the database
                    }
                }

                return res.status(200).json({ success: true });

            } 
            
            // ACTION: BATCH UPDATE (FROM CMS TABLE)
            else if (action === 'updateBatch') {
                for (const uid of Object.keys(payload)) {
                    await supabase.from('app_users').update(payload[uid]).eq('userid', uid);
                }
                return res.status(200).json({ success: true });
            } 
            
            // ACTION: DELETE USER
            else if (action === 'delete') {
                const { error: delError } = await supabase
                    .from('app_users')
                    .delete()
                    .eq('userid', userid);
                
                if (delError) throw delError;
                return res.status(200).json({ success: true });
            }
        }
    } catch (err) {
        console.error("Global API Error:", err);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
}
