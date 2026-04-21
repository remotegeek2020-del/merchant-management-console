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
      // 1. Fetch the user from DB to check the stored code
      const { data: tfaUser } = await supabase.from('app_users').select('*').eq('userid', userId).single();
      
      // FIX: Check 'tfaUser' (the data we just fetched), not 'user'
      if (tfaUser && tfaUser.tfa_code === code) {
        let newDeviceToken = null;

        // 2. If 'Remember Me' is checked, generate and save the token
        if (remember) {
          newDeviceToken = crypto.randomUUID();
          await supabase.from('trusted_devices').insert({ 
            userid: userId, 
            device_token: newDeviceToken 
          });
        }

        // 3. Clear the 2FA code so it cannot be reused
        await supabase.from('app_users').update({ tfa_code: null }).eq('userid', userId);
        
        // 4. Set the 'user' variable so the cleanUser logic at the bottom can process it
        user = tfaUser;
        
        // 5. Explicitly attach the newDeviceToken to the response for the frontend
        req.body.newDeviceToken = newDeviceToken; 
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
        // [Inside api/login.js -> action === 'login']
if (isMatch) {
    // 1. Check for the token sent from frontend
    const sentToken = req.body.deviceToken; 

    const { data: trusted } = await supabase
        .from('trusted_devices')
        .select('*')
        .eq('userid', dbUser.userid)
        .eq('device_token', sentToken || 'none') // Ensure it doesn't match empty rows
        .gt('expires_at', new Date().toISOString())
        .single();

           if (trusted) {
        // SUCCESS: Device recognized. Update 'last_used' timestamp
        await supabase.from('trusted_devices')
            .update({ last_used: new Date().toISOString() })
            .eq('id', trusted.id);
            
        user = dbUser; // Proceed to login
    } else {
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
      return res.status(401).json({ success: false, message: 'Authentication failed' });
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
        newDeviceToken: (action === 'verify2FA' && remember) ? req.body.newDeviceToken : null 
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}
