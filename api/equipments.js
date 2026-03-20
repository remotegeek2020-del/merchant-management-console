import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    // Vercel pulls these from your Environment Variables automatically
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterLocation, limit = 50, page = 0 } = req.body;

    try {
        // --- ACTION: LIST INVENTORY ---
        if (action === 'list') {
            // Use explicit relationship to avoid ambiguity errors
            let sb = supabase.from('equipments').select(`
                *,
                merchants!merchant_id (dba_name)
            `, { count: 'exact' });

            // Search by Serial or Terminal Type
            if (query) {
                sb = sb.or(`serial_number.ilike.%${query}%,terminal_type.ilike.%${query}%`);
            }

            // Filter by Warsaw Office vs Warsaw Repairs
            if (filterLocation) {
                sb = sb.eq('current_location', filterLocation);
            }

            const { data, count, error } = await sb
                .order('created_at', { ascending: false })
                .range(page * limit, (page + 1) * limit - 1);

            if (error) throw error;

            // Fetch all statuses for the KPI cards
            const { data: allData, error: statsError } = await supabase
                .from('equipments')
                .select('status, current_location');
            
            if (statsError) throw statsError;

            // Calculate metrics (ensures spinner stops even with 0 items)
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

        // --- ACTION: ADD NEW EQUIPMENT ---
        if (action === 'create') {
            const { data, error } = await supabase.from('equipments').insert([payload]);
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // --- ACTION: UPDATE EQUIPMENT ---
        if (action === 'update') {
            const { data, error } = await supabase.from('equipments').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // --- ACTION: DEPLOY TO MERCHANT ---
        if (action === 'deploy') {
            const { merchant_id } = payload;
            const { data, error } = await supabase.from('equipments')
                .update({ 
                    merchant_id, 
                    status: 'deployed', 
                    current_location: 'Merchant Site' 
                })
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ message: 'Unknown action' });

    } catch (err) {
        console.error('Inventory Engine Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
