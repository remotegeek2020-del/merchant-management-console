// api/setup-password.js
import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { token, password } = req.body;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // 1. Find user with this token
    const { data: user, error: findError } = await supabase
      .from('app_users')
      .select('userid')
      .eq('invitation_token', token)
      .eq('is_active', false)
      .single();

    if (findError || !user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired invitation token.' });
    }

    // 2. Hash the new password
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);

    // 3. Update user: set password, activate account, and clear token
    const { error: updateError } = await supabase
      .from('app_users')
      .update({
        password_hash: hash,
        is_active: true,
        invitation_token: null // Token is one-time use
      })
      .eq('userid', user.userid);

    if (updateError) throw updateError;

    return res.status(200).json({ success: true, message: 'Account activated successfully.' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: 'Server error during setup.' });
  }
}
