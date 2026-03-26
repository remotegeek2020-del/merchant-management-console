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
        if (action === 'getHistory') {
    const { data, error } = await supabase
        .from('equipment_logs')
        .select('*')
        .eq('equipment_id', req.body.equipment_id)
        .order('created_at', { ascending: false });

    if (error) throw error;
    return res.status(200).json({ success: true, data: data || [] });
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
            const limit = parseInt(req.body.limit) || 50;
            const page = parseInt(req.body.page) || 0;
            const { query, filterLocation, filterStatus } = req.body;

            // 1. Main Data Query with Pagination
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

            if (error) {
                console.error("Supabase Data Error:", error.message);
                throw error;
            }

            // 2. High-Performance KPI Counts
            // We use 'head: true' so NO data is transferred, only the integer count.
            // This is how you handle 50,000+ rows without timeouts.
            let metrics = { total: 0, inOffice: 0, inRepair: 0, deployed: 0, retired: 0, alerts: 0 };
            
            try {
                const [
                    { count: totalCount },
                    { count: officeCount },
                    { count: repairCount },
                    { count: deployedCount },
                    { count: retiredCount }
                ] = await Promise.all([
                    supabase.from('equipments').select('*', { count: 'exact', head: true }),
                    supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('current_location', 'Warsaw Office').eq('status', 'stocked'),
                    supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('current_location', 'Warsaw Repairs'),
                    supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'deployed'),
                    supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'decommissioned')
                ]);

                metrics = {
                    total: totalCount || 0,
                    inOffice: officeCount || 0,
                    inRepair: repairCount || 0,
                    deployed: deployedCount || 0,
                    retired: retiredCount || 0,
                    alerts: repairCount || 0 
                };
            } catch (metricErr) {
                console.error("Metric Calculation Failed:", metricErr.message);
                // We keep the default 0s so the table can still render
            }

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
