import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  // Only allow POST requests for security
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { email, passkey, userId, action } = req.body;

  // Initialize Supabase using secure Server-Side environment variables
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    let query = supabase.from('app_users').select('*');

    // Route logic based on the action sent by script.js
    switch (action) {
      case 'login':
        // Manual login: check both email and passkey
        query = query.eq('email', email).eq('passkey', passkey);
        break;
      
      case 'validate':
        // Gatekeeper check: check the unique User ID
        if (!userId) return res.status(400).json({ success: false, message: 'Missing User ID' });
        query = query.eq('userid', userId);
        break;

      default:
        return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    const { data: user, error } = await query.single();

    if (error || !user) {
      return res.status(401).json({ success: false, message: 'Authentication failed' });
    }

    // Success: Return the user data (Vercel secures the transit)
    return res.status(200).json({ success: true, user });
    
  } catch (err) {
    console.error("Server Error:", err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}
