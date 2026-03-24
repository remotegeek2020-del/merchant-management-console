import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, page = 0, limit = 50 } = req.body;

    try {
        if (action === 'list') {
            let sb = supabase.from('returns').select(`
                id,
                return_id,
                return_reason,
                condition,
                destination,
                status,
                created_at,
                merchants:merchant_id (dba_name, merchant_id),
                equipments:equipment_id (serial_number, terminal_type)
            `, { count: 'exact' });

            if (query) {
                sb = sb.or(`return_id.ilike.%${query}%,condition.ilike.%${query}%`);
            }

            const { data, count, error } = await sb
                .range(page * limit, (page + 1) * limit - 1)
                .order('created_at', { ascending: false });

            if (error) throw error;

            const metrics = {
                open: data.filter(d => d.status === 'open').length,
                defective: data.filter(d => d.condition === 'Defective').length,
                total: count
            };

            return res.status(200).json({ success: true, data, count, metrics });
        }

        if (action === 'update') {
            const { status, condition, destination } = payload;
            const { error } = await supabase
                .from('returns')
                .update({ status, condition, destination })
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
