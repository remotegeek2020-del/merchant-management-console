import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, equipment_id } = req.body;

    try {
        if (action === 'list') {
            let sb = supabase.from('deployments').select(`
                *,
                merchants!merchant_id (dba_name),
                equipments!equipment_id (id, serial_number, terminal_type)
            `);

            if (query) {
                sb = sb.or(`deployment_id.ilike.%${query}%,tid.ilike.%${query}%,tracking_id.ilike.%${query}%`);
            }

            const { data, error } = await sb.order('created_at', { ascending: false });
            if (error) throw error;

            const metrics = {
                active: data.filter(d => d.status === 'Open').length || 0,
                total: data.length || 0,
                today: data.filter(d => new Date(d.created_at).toDateString() === new Date().toDateString()).length || 0
            };

            return res.status(200).json({ success: true, data: data || [], metrics });
        }

        // --- NEW ACTION: FETCH EQUIPMENT HISTORY ---
        if (action === 'getHistory') {
            if (!equipment_id) return res.status(400).json({ message: "Equipment ID required" });

            const { data, error } = await supabase
                .from('equipment_logs')
                .select(`
                    *,
                    merchants (dba_name)
                `)
                .eq('equipment_id', equipment_id)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

    } catch (err) {
        console.error("Deployment API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
