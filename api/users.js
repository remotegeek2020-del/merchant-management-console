// api/users.js
import { createClient } from '@supabase/supabase-js';
import { ServerClient } from 'postmark';
import crypto from 'crypto';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    try {
        // 1. Handle Listing (GET)
        if (req.method === 'GET' || req.query.action === 'list') {
            const { data, error } = await supabase.from('app_users').select('*').order('first_name');
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // 2. Handle Actions (POST)
        if (req.method === 'POST') {
            const { action, payload, userid } = req.body;

            if (action === 'insert') {
                const invitationToken = crypto.randomUUID();
                
                const newUser = {
                    ...payload,
                    invitation_token: invitationToken,
                    is_active: false,
                    passkey: 'PENDING_SETUP'
                };

                const { error: insertError } = await supabase.from('app_users').insert([newUser]);
                
                if (insertError) {
                    return res.status(400).json({ success: false, message: insertError.message });
                }

                // --- POSTMARK TRIGGER ---
                // Only attempt to send if the token exists to prevent crashing during local tests
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
                                <h1>Welcome to the Team, ${payload.first_name}!</h1>
                                <p>Please click below to set your password:</p>
                                <a href="${setupUrl}" style="background-color: #004990; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Set Up Password</a>
                                <p>${setupUrl}</p>
                            `,
                            "TextBody": `Welcome! Set up your account here: ${setupUrl}`,
                            "MessageStream": "outbound"
                        });
                    } catch (mailErr) {
                        console.error("Mail Delivery Failed:", mailErr);
                        // We don't return error here because the user WAS created in DB successfully
                    }
                }

                return res.status(200).json({ success: true });

            } else if (action === 'updateBatch') {
                for (const uid of Object.keys(payload)) {
                    await supabase.from('app_users').update(payload[uid]).eq('userid', uid);
                }
                return res.status(200).json({ success: true });
            } else if (action === 'delete') {
                await supabase.from('app_users').delete().eq('userid', userid);
                return res.status(200).json({ success: true });
            }
        }
    } catch (err) {
        console.error("Global API Error:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
