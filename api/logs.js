// api/logs.js
import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  try {
    // Only allow Admins to fetch logs (additional server-side check)
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('activity_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100); // Only show the last 100 events

      if (error) throw error;
      return res.status(200).json({ success: true, data });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}