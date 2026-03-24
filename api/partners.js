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
    const { data, error } = await supabase.rpc('get_partner_network_v2');

    if (error) {
        console.error("RPC V2 Error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }

    // Map the internal 'partner_name' to the 'name' field the UI expects
    const formatted = (data || []).map(item => ({
        ...item,
        name: item.partner_name || 'Unnamed Partner'
    }));

    return res.status(200).json({ success: true, data: formatted });
}
