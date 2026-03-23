import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterLocation, filterStatus, limit = 50, page = 0 } = req.body;

    try {
        if (action === 'getActivityLogs') {
            const { data, error } = await supabase
                .from('activity_logs')
                .select('*')
                .ilike('status', `%${req.body.serial}%`) 
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'delete') {
            const { data, error } = await supabase
                .from('equipments')
                .delete()
                .eq('id', id);
                
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }
        
        if (action === 'getNotes') {
            const { data, error } = await supabase
                .from('equipment_notes')
                .select('*')
                .eq('equipment_id', req.body.equipment_id)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'saveNote') {
            const { data, error } = await supabase
                .from('equipment_notes')
                .insert([{ 
                    equipment_id: req.body.equipment_id, 
                    note_text: req.body.note_text, 
                    author_name: req.headers['x-user-name'] || 'Staff Member' 
                }]);

            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'list') {
            let sb = supabase.from('equipments').select(`
                *,
                merchants!current_merchant (dba_name)
            `, { count: 'exact' });

            if (query) {
                sb = sb.or(`serial_number.ilike.%${query}%,terminal_type.ilike.%${query}%`);
            }

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

            // UPDATED METRICS CALCULATION
            const metrics = {
                total: allData.length || 0,
                inOffice: allData.filter(i => i.current_location === 'Warsaw Office' && i.status !== 'decommissioned').length || 0,
                inRepair: allData.filter(i => i.current_location === 'Warsaw Repairs').length || 0,
                deployed: allData.filter(i => i.status === 'deployed').length || 0,
                retired: allData.filter(i => i.status === 'decommissioned').length || 0 // Added this line

                // NEW ALERT METRIC
    alerts: allData.filter(i => 
        i.current_location === 'Warsaw Repairs' && 
        new Date(i.updated_at) < fourteenDaysAgo
    ).length || 0
            };

            return res.status(200).json({ 
                success: true, 
                data: data || [], 
                count: count || 0, 
                metrics 
            });
        }

        if (action === 'create') {
            const { data, error } = await supabase
                .from('equipments')
                .insert([payload]); 
                
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'update') {
            const { data: updatedData, error: updateError } = await supabase
                .from('equipments')
                .update(payload)
                .eq('id', id)
                .select(); 

            if (updateError) throw updateError;

            await supabase.from('activity_logs').insert([{
                email: req.headers['x-user-email'] || 'System Admin',
                action: 'Update Equipment',
                status: `Serial ${payload.serial_number} set to ${payload.status}`,
                user_agent: req.headers['user-agent'],
                ip_address: req.headers['x-forwarded-for'] || 'internal'
            }]);

            return res.status(200).json({ success: true, data: updatedData });
        }

        return res.status(400).json({ message: 'Unknown action' });

    } catch (err) {
        console.error('Inventory Engine Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
