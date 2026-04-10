import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, sender_id, recipient_id, content } = req.body;

    try {
        // Handle Logout: Wipe last_seen so the green dot disappears
        if (action === 'logout' && sender_id) {
            await supabase.from('app_users').update({ last_seen: null }).eq('userid', sender_id);
            return res.status(200).json({ success: true });
        }

        // Update Last Seen (if not logging out)
        if (sender_id && action !== 'logout') {
            await supabase.from('app_users').update({ last_seen: new Date().toISOString() }).eq('userid', sender_id);
        }

        if (action === 'sendMessage') {
            const { data, error } = await supabase
                .from('messages')
                .insert([{ 
                    sender_id: sender_id, 
                    recipient_id: recipient_id, 
                    content: content,
                    is_read: false 
                }]);
            
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'getHistory') {
            // Mark incoming messages as read
            await supabase.from('messages').update({ is_read: true })
                .eq('sender_id', recipient_id).eq('recipient_id', sender_id).eq('is_read', false);

            const { data, error } = await supabase.from('messages').select('*')
                .or(`and(sender_id.eq.${sender_id},recipient_id.eq.${recipient_id}),and(sender_id.eq.${recipient_id},recipient_id.eq.${sender_id})`)
                .order('created_at', { ascending: true });
            
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }
        
        if (action === 'getUserList') {
            // FIXED: Added .order('first_name') so the list doesn't jump around
            const { data: users, error: userError } = await supabase
                .from('app_users')
                .select('userid, first_name, last_name, last_seen')
                .order('first_name', { ascending: true });
            
            if (userError) throw userError;
            
            const { data: unreadData } = await supabase.from('messages').select('sender_id')
                .eq('recipient_id', sender_id).eq('is_read', false);

            const counts = {};
            unreadData?.forEach(m => { counts[m.sender_id] = (counts[m.sender_id] || 0) + 1; });

            return res.status(200).json({ success: true, data: users, unreadCounts: counts });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
