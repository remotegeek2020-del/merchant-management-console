import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, sender_id, recipient_id, content } = req.body;
    // Add this inside your export default async function handler(req, res) {
if (req.body.sender_id) {
    await supabase.from('app_users').update({ last_seen: new Date() }).eq('userid', req.body.sender_id);
}


    try {
        
        if (action === 'sendMessage') {
            const { data, error } = await supabase
                .from('messages')
                .insert([{ sender_id, recipient_id, content }]);
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'getHistory') {
            // Fetch messages between two specific users
            const { data, error } = await supabase
                .from('messages')
                .select('*')
                .or(`and(sender_id.eq.${sender_id},recipient_id.eq.${recipient_id}),and(sender_id.eq.${recipient_id},recipient_id.eq.${sender_id})`)
                .order('created_at', { ascending: true });
            
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }
        
        if (action === 'getUserList') {
            const { data, error } = await supabase.from('app_users').select('userid, first_name, last_name');
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
