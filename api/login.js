import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { email, passkey, userId, action } = req.body;
  
  const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    let user = null;
    let error = null;

    // [INSIDE THE try BLOCK OF api/login.js]
if (action === 'login') {
    // ... existing login code ...
} else if (action === 'validate') {
    // ... existing validate code ...
} else if (action === 'forgotPassword') {
    // 1. Fetch user to confirm they exist
    const { data: user } = await supabase
        .from('app_users')
        .select('userid, first_name, email')
        .eq('email', email)
        .single();

    if (user) {
        const resetToken = require('crypto').randomUUID();
        // 2. Set user to inactive and store reset token
        await supabase
            .from('app_users')
            .update({ invitation_token: resetToken, is_active: false })
            .eq('userid', user.userid);

        // 3. Send Email via Postmark (Re-using your existing invitation logic)
        const { ServerClient } = require('postmark');
        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
        const setupUrl = `https://${req.headers.host}/setup-password.html?token=${resetToken}`;
        
        await client.sendEmail({
            "From": process.env.EMAIL_FROM,
            "To": user.email,
            "Subject": "Reset your PayProtec Portal Password",
            "HtmlBody": `<p>Hello ${user.first_name},</p><p>Click below to reset your password:</p><a href="${setupUrl}">${setupUrl}</a>`
        });
    }
    return res.status(200).json({ success: true }); // Always return true for security
}

    if (action === 'login') {
      const { data, error: fetchError } = await supabase
        .from('app_users')
        .select('*')
        .eq('email', email)
        .single();
      
      if (fetchError) {
          error = fetchError;
      } else if (data) {
        if (!data.is_active) {
            return res.status(401).json({ success: false, message: 'Account not activated.' });
        }

        const isMatch = bcrypt.compareSync(passkey, data.password_hash);
        if (isMatch) {
            user = data;
        } else {
            error = { message: 'Invalid password' };
        }
      }
    } else if (action === 'validate') {
      const { data, error: valError } = await supabase
        .from('app_users')
        .select('*')
        .eq('userid', userId)
        .single();
      user = data;
      error = valError;
    }

    // Log attempt
    await supabase.from('activity_logs').insert([{
      email: email || (user ? user.email : 'Unknown'),
      action: action,
      status: (!error && user) ? 'SUCCESS' : 'FAILURE',
      user_agent: req.headers['user-agent'],
      ip_address: req.headers['x-forwarded-for'] || 'Internal'
    }]);

    if (error || !user) {
      return res.status(401).json({ success: false, message: 'Authentication failed' });
    }

    // --- CRITICAL FIX: EXPLICITLY RETURN THE CLEAN OBJECT ---
    // This ensures no properties are 'lost' or accidentally 'deleted' from the reference
    const cleanUser = {
        userid: user.userid,
        first_name: user.first_name,
        email: user.email,
        role: user.role, // This is what the Guard script needs!
        access_inventory: user.access_inventory,
        access_deployments: user.access_deployments,
        access_returns: user.access_returns,
        access_merchants: user.access_merchants
    };

    return res.status(200).json({ success: true, user: cleanUser });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}
