import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, sender_id, recipient_id, content } = req.body;

    try {
        // 1. UPDATE LAST SEEN (Every time any action is called)
        if (sender_id) {
            await supabase
                .from('app_users')
                .update({ last_seen: new Date().toISOString() })
                .eq('userid', sender_id);
        }

        // 2. SEND MESSAGE
        if (action === 'sendMessage') {
            const { data, error } = await supabase
                .from('messages')
                .insert([{ sender_id, recipient_id, content, is_read: false }]);
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // 3. GET HISTORY (And mark incoming messages as read)
        if (action === 'getHistory') {
            // Mark messages sent TO me BY this specific user as read
            await supabase
                .from('messages')
                .update({ is_read: true })
                .eq('sender_id', recipient_id)
                .eq('recipient_id', sender_id)
                .eq('is_read', false);

            const { data, error } = await supabase
                .from('messages')
                .select('*')
                .or(`and(sender_id.eq.${sender_id},recipient_id.eq.${recipient_id}),and(sender_id.eq.${recipient_id},recipient_id.eq.${sender_id})`)
                .order('created_at', { ascending: true });
            
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }
        
        // 4. GET USER LIST (Including Online Status and Unread Counts)
        if (action === 'getUserList') {
            // Fetch users with their last_seen status
            const { data: users, error: userError } = await supabase
                .from('app_users')
                .select('userid, first_name, last_name, last_seen');
            
            if (userError) throw userError;

            // Fetch counts of unread messages sent TO the current user
            const { data: unreadData, error: unreadError } = await supabase
                .from('messages')
                .select('sender_id')
                .eq('recipient_id', sender_id)
                .eq('is_read', false);

            if (unreadError) throw unreadError;

            // Group unread counts by sender_id
            const unreadCounts = {};
            unreadData?.forEach(m => {
                unreadCounts[m.sender_id] = (unreadCounts[m.sender_id] || 0) + 1;
            });

            return res.status(200).json({ 
                success: true, 
                data: users, 
                unreadCounts: unreadCounts 
            });
        }

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
