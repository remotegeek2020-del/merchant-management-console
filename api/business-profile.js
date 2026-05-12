import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Auth check — must be active admin
    const userid = req.body?.userid || req.query?.userid;
    if (!userid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const { data: user } = await supabase.from('app_users').select('role, is_active').eq('userid', userid).single();
    if (!user?.is_active) return res.status(403).json({ success: false, message: 'Access denied' });
    const role = (user.role || '').toLowerCase().trim();
    const isAdmin = role === 'super_admin' || role === 'operations admin' || role === 'admin';

    if (req.method === 'GET') {
        const { data, error } = await supabase.from('business_profile').select('*').eq('id', 1).single();
        if (error) return res.status(500).json({ success: false, message: error.message });
        return res.status(200).json({ success: true, data });
    }

    if (req.method === 'POST') {
        if (!isAdmin) return res.status(403).json({ success: false, message: 'Admin access required' });
        const { friendly_name, legal_name, business_email, business_phone, street_address, city, postal_code, state_region, country, timezone } = req.body;
        const { error } = await supabase.from('business_profile').update({
            friendly_name, legal_name, business_email, business_phone,
            street_address, city, postal_code, state_region, country, timezone,
            updated_at: new Date().toISOString(),
            updated_by: userid
        }).eq('id', 1);
        if (error) return res.status(500).json({ success: false, message: error.message });
        return res.status(200).json({ success: true });
    }

    return res.status(405).json({ success: false, message: 'Method not allowed' });
}
