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
