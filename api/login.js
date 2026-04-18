import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { email, passkey, userId, action } = req.body; // 'passkey' now acts as the password input
  
  const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    let user = null;
    let error = null;

    if (action === 'login') {
      // 1. Fetch user by email only
      const { data, error: fetchError } = await supabase
        .from('app_users')
        .select('*')
        .eq('email', email)
        .single();
      
      error = fetchError;
      
      if (data) {
        // 2. Check if user is active (set their password)
        if (!data.is_active) {
            return res.status(401).json({ success: false, message: 'Account not activated. Please check your email.' });
        }

        // 3. Verify the password against the hash
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

    // Securely log the attempt
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

    // Remove sensitive data before returning to frontend
    delete user.password_hash;
    delete user.invitation_token;

    return res.status(200).json({ success: true, user });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}
