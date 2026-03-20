import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    // Vercel pulls these from your Environment Variables automatically
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, filterLocation, limit = 50, page = 0 } = req.body;

    try {
        if (action === 'list') {
            // 1. Build the main query
          let sb = supabase.from('equipments').select(`
        *,
        merchants!merchant_id (dba_name) 
    `, { count: 'exact' });

            if (query) {
                sb = sb.or(`serial_number.ilike.%${query}%,terminal_type.ilike.%${query}%`);
            }

            if (filterLocation) {
                sb = sb.eq('current_location', filterLocation);
            }

            const { data, count, error } = await sb
                .order('created_at', { ascending: false })
                .range(page * limit, (page + 1) * limit - 1);

            if (error) throw error;

            // 2. Fetch all statuses for the KPI cards
            const { data: allData, error: statsError } = await supabase
                .from('equipments')
                .select('status, current_location');
            
            if (statsError) throw statsError;

            // 3. Calculate metrics (ensures spinner stops even with 0 items)
            const metrics = {
                total: allData.length || 0,
                inOffice: allData.filter(i => i.current_location === 'Warsaw Office').length || 0,
                inRepair: allData.filter(i => i.current_location === 'Warsaw Repairs').length || 0,
                deployed: allData.filter(i => i.status === 'deployed').length || 0
            };

            return res.status(200).json({ 
                success: true, 
                data: data || [], 
                count: count || 0, 
                metrics 
            });
        }
        
        // ... (keep your create/update actions as they were)
        
    } catch (err) {
        console.error('Inventory Engine Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
