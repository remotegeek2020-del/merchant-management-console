import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body;

    try {
        if (action === 'get_kpis') {
            const weekStart = new Date();
            weekStart.setDate(weekStart.getDate() - weekStart.getDay());
            weekStart.setHours(0, 0, 0, 0);

            const [merchantStats, deploymentCount, openRmaCount, equipRows, newThisWeek, recentActivity] = await Promise.all([
                supabase.from('merchant_stats_by_id').select('merchant_count, pending_count, closed_count, total_volume_sum, total_volume_90d_sum'),
                supabase.from('deployments').select('*', { count: 'exact', head: true }).in('status', ['Open', 'In Transit']),
                supabase.from('returns').select('*', { count: 'exact', head: true }).eq('status', 'Open'),
                supabase.from('equipments').select('status, current_location'),
                supabase.from('merchants').select('*', { count: 'exact', head: true }).gte('enrollment_date', weekStart.toISOString()),
                supabase.from('activity_logs').select('email, action, status, created_at').order('created_at', { ascending: false }).limit(12)
            ]);

            let approved = 0, pending = 0, closed = 0, mtd = 0, vol90 = 0;
            (merchantStats.data || []).forEach(s => {
                approved += parseInt(s.merchant_count || 0);
                pending  += parseInt(s.pending_count || 0);
                closed   += parseInt(s.closed_count || 0);
                mtd      += parseFloat(s.total_volume_sum || 0);
                vol90    += parseFloat(s.total_volume_90d_sum || 0);
            });

            const equip = { stocked: 0, deployed: 0, repair: 0 };
            (equipRows.data || []).forEach(e => {
                if (e.status === 'deployed') equip.deployed++;
                else if ((e.current_location || '').toLowerCase().includes('repair')) equip.repair++;
                else equip.stocked++;
            });

            return res.status(200).json({
                success: true,
                kpis: {
                    approved, pending, closed,
                    total_mtd: mtd,
                    total_90d: vol90,
                    active_deployments: deploymentCount.count || 0,
                    open_rmas: openRmaCount.count || 0,
                    new_this_week: newThisWeek.count || 0,
                    equipment: equip
                },
                recent_activity: recentActivity.data || []
            });
        }

        if (action === 'get_at_risk') {
            const { data, error } = await supabase
                .from('merchants')
                .select('merchant_id, dba_name, agent_id, volume_30_day, volume_90_day, last_batch_date')
                .eq('account_status', 'Approved')
                .gt('volume_90_day', 0)
                .order('volume_30_day', { ascending: true })
                .limit(200);

            if (error) throw error;

            const atRisk = (data || [])
                .map(m => {
                    const baseline = parseFloat(m.volume_90_day) / 3;
                    const vol30 = parseFloat(m.volume_30_day);
                    return { ...m, baseline, drop_pct: Math.round((1 - vol30 / baseline) * 100) };
                })
                .filter(m => m.drop_pct >= 15)
                .sort((a, b) => b.drop_pct - a.drop_pct);

            return res.status(200).json({ success: true, data: atRisk });
        }

        if (action === 'get_recent_deployments') {
            const { data, error } = await supabase
                .from('deployments')
                .select('id, deployment_id, status, created_at, purchase_type, merchants:merchant_id(dba_name, merchant_id), equipments:equipment_id(serial_number, terminal_type)')
                .order('created_at', { ascending: false })
                .limit(8);
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('Admin Dashboard Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
