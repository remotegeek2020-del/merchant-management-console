import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  // Only allow POST requests for security
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { email, passkey } = req.body;

  // These are pulled from Vercel's Environment Variables, NOT hardcoded
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Check the registry for the user
    const { data: user, error } = await supabase
      .from('app_users')
      .select('*')
      .eq('email', email)
      .eq('passkey', passkey)
      .single();

    if (error || !user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Return the user data to the frontend (excluding sensitive fields if necessary)
    return res.status(200).json({ success: true, user });
    
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}