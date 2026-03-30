// api/users.js
import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  try {
    // 1. Handle Listing (GET)
    if (req.method === 'GET' || req.query.action === 'list') {
      const { data, error } = await supabase.from('app_users').select('*').order('first_name');
      if (error) throw error;
      return res.status(200).json({ success: true, data });
    }

    // 2. Handle Actions (POST)
    if (req.method === 'POST') {
      const { action, payload, userid } = req.body;

      if (action === 'updateBatch') {
        for (const uid of Object.keys(payload)) {
          await supabase.from('app_users').update(payload[uid]).eq('userid', uid);
        }
      } else if (action === 'updateSingle') {
        await supabase.from('app_users').update(payload).eq('userid', userid);
      } else if (action === 'insert') {
        await supabase.from('app_users').insert([payload]);
      } else if (action === 'delete') {
        await supabase.from('app_users').delete().eq('userid', userid);
      }
      
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    console.error("API Error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}
