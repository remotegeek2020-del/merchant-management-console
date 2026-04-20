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
                        await client.sendEmail({
                            "From": process.env.EMAIL_FROM,
                            "To": payload.email,
                            "Subject": "Set up your PayProtec account",
                            "HtmlBody": `<p>Welcome! Set up your password here: <a href="${setupUrl}">${setupUrl}</a></p>`,
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
