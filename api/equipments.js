const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const { action, id, payload, query, filterLocation, limit = 50, page = 0 } = req.body;

    try {
        // --- ACTION: LIST INVENTORY ---
        if (action === 'list') {
            let sb = supabase.from('equipments').select(`
                *,
                merchants:merchant_id (dba_name)
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

            // Calculate Quick Stats for the Header
            const { data: statsData } = await supabase.from('equipments').select('status, current_location');
            const metrics = {
                total: statsData.length,
                inOffice: statsData.filter(i => i.current_location === 'Warsaw Office').length,
                inRepair: statsData.filter(i => i.current_location === 'Warsaw Repairs').length,
                deployed: statsData.filter(i => i.status === 'deployed').length
            };

            return res.status(200).json({ success: true, data, count, metrics });
        }

        // --- ACTION: ADD NEW EQUIPMENT ---
        if (action === 'create') {
            const { data, error } = await supabase.from('equipments').insert([payload]);
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // --- ACTION: UPDATE EQUIPMENT (Move to Repair, Change Status, etc.) ---
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
