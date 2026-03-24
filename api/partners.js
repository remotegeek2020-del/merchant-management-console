import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    
    const supabase = createClient(
        process.env.SUPABASE_URL, 
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { action, person_id } = req.body || {};

    try {
        if (action === 'get_partners_list') {
            // Call the database function directly
            const { data, error } = await supabase.rpc('get_partner_network');

            if (error) throw error;

            return res.status(200).json({ 
                success: true, 
                data: data || [] 
            });
        }

        // Keep your hierarchy logic here...
        if (action === 'get_hierarchy') {
            // ... (keep the previous get_hierarchy code)
        }

    } catch (err) {
        console.error("RPC Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
