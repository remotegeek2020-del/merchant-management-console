// api/users.js
import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  
  try {
    if (req.method === 'GET') {
      const { data } = await supabase.from('app_users').select('*').order('first_name');
      return res.status(200).json({ success: true, data });
    }

    if (req.method === 'POST') {
      const { action, payload, userid } = req.body;

      if (action === 'updateBatch') {
        for (const uid of Object.keys(payload)) {
          await supabase.from('app_users').update(payload[uid]).eq('userid', uid);
        }
      } else if (action === 'insert') {
        await supabase.from('app_users').insert([payload]);
      } else if (action === 'delete') {
        await supabase.from('app_users').delete().eq('userid', userid);
      }
      return res.status(200).json({ success: true });
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}