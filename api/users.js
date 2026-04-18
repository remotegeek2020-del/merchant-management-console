// api/users.js
import { createClient } from '@supabase/supabase-js'
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

      if (action === 'updateBatch') {
        for (const uid of Object.keys(payload)) {
          await supabase.from('app_users').update(payload[uid]).eq('userid', uid);
        }
      } else if (action === 'updateSingle') {
        await supabase.from('app_users').update(payload).eq('userid', userid);
     } else if (action === 'insert') {
        const invitationToken = crypto.randomUUID();
        const newUser = {
            ...payload,
            invitation_token: invitationToken,
            is_active: false,
            passkey: 'PENDING_SETUP'
        };

        const { error } = await supabase.from('app_users').insert([newUser]);
        if (error) throw error;

        // --- POSTMARK EMAIL INTEGRATION ---
        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
        const setupUrl = `https://${req.headers.host}/setup-password.html?token=${invitationToken}`;

        await client.sendEmail({
            "From": process.env.EMAIL_FROM,
            "To": payload.email,
            "Subject": "Action Required: Set up your PayProtec Staff Portal account",
            "HtmlBody": `
                <h1>Welcome to the Team, ${payload.first_name}!</h1>
                <p>Your access to the PayProtec Staff Portal has been authorized.</p>
                <p>Please click the button below to set your password and activate your account:</p>
                <a href="${setupUrl}" style="background-color: #004990; color: white; padding: 12px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Set Up Password</a>
                <p>If the button doesn't work, copy and paste this link into your browser:</p>
                <p>${setupUrl}</p>
                <p>This invitation will expire after its first use.</p>
            `,
            "TextBody": `Welcome ${payload.first_name}! Set up your account here: ${setupUrl}`,
            "MessageStream": "outbound"
        });
    }
        // --- SECURE ENROLLMENT LOGIC ---
        
        // 1. Generate a unique invitation token
        const invitationToken = crypto.randomUUID();
        
        // 2. Prepare the new user object
        const newUser = {
            ...payload,
            invitation_token: invitationToken,
            is_active: false, // Prevents login until password is set
            passkey: 'PENDING_SETUP' // Legacy support placeholder
        };

        // 3. Insert into Supabase
        const { error } = await supabase.from('app_users').insert([newUser]);
        
        if (error) {
            // Check for duplicate email error specifically
            if (error.code === '23505') {
                return res.status(400).json({ success: false, message: 'A user with this email already exists.' });
            }
            throw error;
        }

        // --- FUTURE EMAIL TRIGGER POINT ---
        // This is where we will eventually add the Resend/SendGrid call
        // console.log(`Invitation link: /setup-password.html?token=${invitationToken}`);

      } else if (action === 'delete') {
        await supabase.from('app_users').delete().eq('userid', userid);
      }
      
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    console.error("API Error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}
