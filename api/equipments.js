import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    // Destructure filterStatus from req.body
    const { action, id, payload, query, filterLocation, filterStatus, limit = 50, page = 0 } = req.body;

    try {
        // --- ACTION: GET NOTES ---
if (action === 'getNotes') {
    const { data, error } = await supabase
        .from('equipment_notes')
        .select('*')
        .eq('equipment_id', id)
        .order('created_at', { ascending: false });

    if (error) throw error;
    return res.status(200).json({ success: true, data });
}

// --- ACTION: ADD NOTE ---
if (action === 'addNote') {
    const { data, error } = await supabase.from('equipment_notes').insert([payload]);
    if (error) throw error;
    return res.status(200).json({ success: true, data });
}
        // --- ACTION: LIST INVENTORY ---
        if (action === 'list') {
            let sb = supabase.from('equipments').select(`
                *,
                merchants!current_merchant (dba_name)
            `, { count: 'exact' });

            if (query) {
                sb = sb.or(`serial_number.ilike.%${query}%,terminal_type.ilike.%${query}%`);
            }

            // Minimal Change: Toggle between filtering by Status or Location
            if (filterStatus) {
                sb = sb.eq('status', filterStatus);
            } else if (filterLocation) {
                sb = sb.eq('current_location', filterLocation);
            }

            const { data, count, error } = await sb
                .order('created_at', { ascending: false })
                .range(page * limit, (page + 1) * limit - 1);

            if (error) throw error;

            const { data: allData, error: statsError } = await supabase
                .from('equipments')
                .select('status, current_location');
            
            if (statsError) throw statsError;

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

        if (action === 'create') {
            const { data, error } = await supabase.from('equipments').insert([payload]);
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

      if (action === 'update') {
    const { data, error } = await supabase
        .from('equipments')
        .update(payload) // This 'payload' variable comes from req.body
        .eq('id', id);
        
    if (error) throw error;
    return res.status(200).json({ success: true, data });
}

        if (action === 'deploy') {
            const { merchant_id } = payload;
            const { error } = await supabase.from('equipments')
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
