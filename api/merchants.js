import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    // Vercel automatically injects these from your Environment Variables
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, page = 0 } = req.body;
    const PAGE_SIZE = 15;

    try {
        if (action === 'list') {
            let request = supabase
                .from('merchants')
                .select('*', { count: 'exact' })
                .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
                .order('created_at', { ascending: false });

            // Search logic for DBA Name or Agent ID
            if (query) {
                request = request.or(`dba_name.ilike.%${query}%,agent_id.ilike.%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;
            return res.status(200).json({ success: true, data, count });
        }
        
        // Add more actions here (like 'update' or 'delete') as you grow
    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}