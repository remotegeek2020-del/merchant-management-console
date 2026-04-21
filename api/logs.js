import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  // FETCH LOGS (Existing logic)
  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true, data });
  }

  // NEW: RECORD LOGS (Surgical insertion)
  if (req.method === 'POST') {
    const { email, action, status } = req.body;
    
    const { error } = await supabase.from('activity_logs').insert([{
      email: email,
      action: action,
      status: status,
      user_agent: req.headers['user-agent'],
      ip_address: req.headers['x-forwarded-for'] || 'Internal'
    }]);

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true });
  }
}
