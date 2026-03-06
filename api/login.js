import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { email, passkey, userId, action } = req.body;
  
  // These are your secure Vercel environment variables
  const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    let query = supabase.from('app_users').select('*');

    if (action === 'login') {
      query = query.eq('email', email).eq('passkey', passkey);
    } else if (action === 'validate') {
      query = query.eq('userid', userId);
    }

    const { data: user, error } = await query.single();

    // Securely log the attempt to your activity_logs table
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

    return res.status(200).json({ success: true, user });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}
