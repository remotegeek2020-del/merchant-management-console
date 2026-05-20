import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Resolve actor identity from session — never trust client-provided headers for logging
    const { data: actor } = await supabase
        .from('app_users')
        .select('email, first_name, last_name')
        .eq('userid', session.userid)
        .single();
    const actorEmail = actor?.email || 'Unknown';
    const actorName  = [actor?.first_name, actor?.last_name].filter(Boolean).join(' ') || 'Staff';

    const { action, id, payload, query, filterLocation, filterStatus, limit = 50, page = 0 } = req.body;

    try {

        // --- ADDED: NEW ACTION FOR AI COMPARISON ---
        if (action === 'getAllSerials') {
            const { data, error } = await supabase
                .from('equipments')
                .select('serial_number'); // Light query: only fetch the strings we need
            
            if (error) throw error;
            
            // Return a flat array of strings
            return res.status(200).json({ 
                success: true, 
                serials: data.map(i => i.serial_number) 
            });
        }
      // Inside api/equipments.js handler
if (action === 'getMonthlyReport') {
    const { startDate, endDate, subFilter, offset = 0, limit = 1000 } = req.body;

    let query = supabase
        .from('equipments')
        .select(`
            serial_number, 
            terminal_type, 
            status, 
            current_location, 
            received_date,
            condition
        `, { count: 'exact' }) // Critical: Get total count for large datasets
        .gte('received_date', startDate)
        .lte('received_date', endDate);

    // Apply the specific location filter (Warsaw Office / Warsaw Repairs)
    if (subFilter) {
        query = query.eq('current_location', subFilter);
    }

    const { data, error, count } = await query
        .range(offset, offset + limit - 1)
        .order('received_date', { ascending: false });

    if (error) throw error;

    // Mapping for CSV friendliness
    const rawData = data.map(i => ({
        "Serial Number": i.serial_number,
        "Model": i.terminal_type,
        "Status": i.status,
        "Location": i.current_location,
        "Condition": i.condition || 'N/A',
        "Date Received": i.received_date
    }));

    return res.status(200).json({ success: true, rawData, totalCount: count });
}
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
            const { data: equipToDelete } = await supabase.from('equipments').select('serial_number, terminal_type, status, current_location').eq('id', id).single();
            const { data, error } = await supabase.from('equipments').delete().eq('id', id);
            if (error) throw error;
            supabase.from('activity_logs').insert([{
                email: actorEmail,
                action: `Inventory Deleted — ${equipToDelete?.serial_number || id}`,
                status: 'success', category: 'inventory', target_id: equipToDelete?.serial_number || id, target_type: 'equipment', severity: 'critical',
                old_value: equipToDelete ? { serial_number: equipToDelete.serial_number, terminal_type: equipToDelete.terminal_type, status: equipToDelete.status, current_location: equipToDelete.current_location } : null,
                user_agent: req.headers['user-agent'],
                ip_address: req.headers['x-forwarded-for'] || 'internal'
            }]).then(() => {}).catch(() => {});
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
                    author_name: actorName
                }]);

            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }
        if (action === 'list') {
            const limit = parseInt(req.body.limit) || 50;
            const page = parseInt(req.body.page) || 0;
            const { query, filterLocation, filterStatus } = req.body;

            // SURGICAL FIX: Using the explicit foreign key name 'current_merchant' 
            // identified in your screenshot to resolve the ambiguity.
            let sb = supabase.from('equipments').select(`
                *,
                merchants!current_merchant(dba_name)
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
                console.error("Table Data Error:", error.message);
                return res.status(500).json({ success: false, message: error.message });
            }

            // --- KPI METRICS (High-Performance for 50k+ records) ---
            let metrics = { total: 0, inOffice: 0, inRepair: 0, deployed: 0, retired: 0, alerts: 0 };
            try {
                const [
                    { count: tCount },
                    { count: oCount },
                    { count: rCount },
                    { count: dCount },
                    { count: rtCount }
                ] = await Promise.all([
                    supabase.from('equipments').select('*', { count: 'exact', head: true }),
                    supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('current_location', 'Warsaw Office').eq('status', 'stocked'),
                    supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('current_location', 'Warsaw Repairs'),
                    supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'deployed'),
                    supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'decommissioned')
                ]);

                metrics = {
                    total: tCount || 0,
                    inOffice: oCount || 0,
                    inRepair: rCount || 0,
                    deployed: dCount || 0,
                    retired: rtCount || 0,
                    alerts: rCount || 0 
                };
            } catch (mErr) { console.warn("Metrics lag:", mErr.message); }

            return res.status(200).json({ success: true, data: data || [], count: count || 0, metrics });
        }
        


        if (action === 'create') {
            const { data, error } = await supabase
                .from('equipments')
                .insert([payload])
                .select()
                .single();

            if (error) throw error;
            supabase.from('activity_logs').insert([{
                email: actorEmail,
                action: `Inventory Created — ${payload.serial_number} (${payload.terminal_type})`,
                status: 'success', category: 'inventory', target_id: payload.serial_number, target_type: 'equipment', severity: 'info',
                new_value: { serial_number: payload.serial_number, terminal_type: payload.terminal_type, status: payload.status, current_location: payload.current_location, received_date: payload.received_date },
                user_agent: req.headers['user-agent'],
                ip_address: req.headers['x-forwarded-for'] || 'internal'
            }]).then(() => {}).catch(() => {});
            return res.status(200).json({ success: true, data });
        }

        if (action === 'update') {
            const { data: oldEquip } = await supabase.from('equipments').select('serial_number, terminal_type, status, current_location').eq('id', id).single();
            const { data: updatedData, error: updateError } = await supabase
                .from('equipments')
                .update(payload)
                .eq('id', id)
                .select();

            if (updateError) throw updateError;

            supabase.from('activity_logs').insert([{
                email: actorEmail,
                action: `Inventory Updated — ${payload.serial_number || oldEquip?.serial_number}`,
                status: 'success', category: 'inventory', target_id: payload.serial_number || oldEquip?.serial_number, target_type: 'equipment', severity: 'info',
                old_value: oldEquip ? { status: oldEquip.status, current_location: oldEquip.current_location } : null,
                new_value: { serial_number: payload.serial_number, terminal_type: payload.terminal_type, status: payload.status, current_location: payload.current_location, received_date: payload.received_date },
                user_agent: req.headers['user-agent'],
                ip_address: req.headers['x-forwarded-for'] || 'internal'
            }]).then(() => {}).catch(() => {});

            return res.status(200).json({ success: true, data: updatedData });
        }

        // --- REPAIR QUEUE ACTIONS ---

        if (action === 'list_repair_queue') {
            const { data, error } = await supabase
                .from('equipments')
                .select('id, serial_number, terminal_type, current_location, condition, received_date, repair_notes, repair_stage')
                .eq('current_location', 'Warsaw Repairs')
                .order('received_date', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'log_repair_action') {
            const { equipment_id, repair_stage, repair_notes } = req.body;
            const { error } = await supabase.from('equipments')
                .update({ repair_stage, repair_notes, condition: repair_stage })
                .eq('id', equipment_id);
            if (error) throw error;
            await supabase.from('equipment_logs').insert([{
                equipment_id,
                action: 'repair_update',
                from_location: 'Warsaw Repairs',
                to_location: 'Warsaw Repairs',
                notes: `Stage: ${repair_stage}. ${repair_notes || ''}. Tech: ${actorName}`
            }]);
            await supabase.from('activity_logs').insert([{
                email: actorEmail,
                action: `Repair Updated — Stage: ${repair_stage}`,
                status: 'success', category: 'inventory', target_id: String(equipment_id), target_type: 'equipment', severity: 'info',
                new_value: { equipment_id, repair_stage, repair_notes: repair_notes || null, technician: actorName },
                user_agent: req.headers['user-agent'],
                ip_address: req.headers['x-forwarded-for'] || 'internal'
            }]);
            return res.status(200).json({ success: true });
        }

        if (action === 'close_repair') {
            const { equipment_id, outcome } = req.body;
            const isScrap = outcome === 'scrap';
            const newStatus = isScrap ? 'decommissioned' : 'stocked';
            const newLocation = isScrap ? 'Scrapped' : 'Warsaw Office';
            const { error } = await supabase.from('equipments')
                .update({ status: newStatus, current_location: newLocation, repair_stage: null, repair_notes: null, merchant_id: null })
                .eq('id', equipment_id);
            if (error) throw error;
            await supabase.from('equipment_logs').insert([{
                equipment_id,
                action: isScrap ? 'scrapped' : 'repair_completed',
                from_location: 'Warsaw Repairs',
                to_location: newLocation,
                notes: `Repair closed by ${actorName}. Outcome: ${isScrap ? 'Scrapped' : 'Returned to stock'}`
            }]);
            await supabase.from('activity_logs').insert([{
                email: actorEmail,
                action: `Repair Closed — ${isScrap ? 'Scrapped' : 'Returned to Stock'}`,
                status: 'success', category: 'inventory', target_id: String(equipment_id), target_type: 'equipment', severity: isScrap ? 'warning' : 'info',
                old_value: { status: 'repairing', current_location: 'Warsaw Repairs' },
                new_value: { status: newStatus, current_location: newLocation, outcome, closed_by: actorName },
                user_agent: req.headers['user-agent'],
                ip_address: req.headers['x-forwarded-for'] || 'internal'
            }]);
            return res.status(200).json({ success: true });
        }

        if (action === 'get_roi_stats') {
            // Fetch all equipment with relevant fields for ROI/utilization analysis
            const { data: allEquipment, error: allError } = await supabase
                .from('equipments')
                .select('id, serial_number, terminal_type, status, current_location, received_date, created_at');

            if (allError) throw allError;

            const now = new Date();
            const IDLE_THRESHOLD_DAYS = 90;

            // Group by terminal_type
            const modelMap = {};
            for (const unit of allEquipment) {
                const model = unit.terminal_type || 'Unknown';
                if (!modelMap[model]) {
                    modelMap[model] = {
                        model,
                        total_units: 0,
                        deployed_units: 0,
                        stocked_units: 0,
                        repair_units: 0,
                        scrapped_units: 0,
                        stocked_days_sum: 0,
                        stocked_days_count: 0,
                        idle_units: 0,
                        idle_serials: []
                    };
                }
                const m = modelMap[model];
                m.total_units++;

                const status = (unit.status || '').toLowerCase();
                if (status === 'deployed') {
                    m.deployed_units++;
                } else if (status === 'stocked') {
                    m.stocked_units++;
                    // Calculate days in stock from received_date or created_at
                    const stockDate = unit.received_date || unit.created_at;
                    if (stockDate) {
                        const d = new Date(stockDate);
                        if (!isNaN(d.getTime())) {
                            const days = Math.floor((now - d) / (1000 * 60 * 60 * 24));
                            m.stocked_days_sum += days;
                            m.stocked_days_count++;
                            if (days > IDLE_THRESHOLD_DAYS) {
                                m.idle_units++;
                                m.idle_serials.push({
                                    serial_number: unit.serial_number,
                                    model: model,
                                    location: unit.current_location,
                                    days_idle: days,
                                    stock_date: stockDate
                                });
                            }
                        }
                    }
                } else if (status === 'repair' || status === 'repairing') {
                    m.repair_units++;
                } else if (status === 'decommissioned' || status === 'scrapped') {
                    m.scrapped_units++;
                }
            }

            // Build model stats array
            const modelStats = Object.values(modelMap).map(m => {
                const active = m.total_units - m.scrapped_units;
                const utilization_rate = active > 0 ? Math.round((m.deployed_units / active) * 100) : 0;
                const avg_days_stocked = m.stocked_days_count > 0 ? Math.round(m.stocked_days_sum / m.stocked_days_count) : 0;
                return {
                    model: m.model,
                    total_units: m.total_units,
                    deployed_units: m.deployed_units,
                    stocked_units: m.stocked_units,
                    repair_units: m.repair_units,
                    scrapped_units: m.scrapped_units,
                    utilization_rate,
                    avg_days_stocked,
                    idle_units: m.idle_units,
                    idle_serials: m.idle_serials.sort((a, b) => b.days_idle - a.days_idle)
                };
            }).sort((a, b) => b.total_units - a.total_units);

            // Build all idle serials list (sorted by days idle desc)
            const allIdleSerials = modelStats
                .flatMap(m => m.idle_serials)
                .sort((a, b) => b.days_idle - a.days_idle);

            // Overall summary
            const totalFleet = allEquipment.length;
            const totalScrapped = modelStats.reduce((s, m) => s + m.scrapped_units, 0);
            const totalDeployed = modelStats.reduce((s, m) => s + m.deployed_units, 0);
            const totalActive = totalFleet - totalScrapped;
            const overallUtilization = totalActive > 0 ? Math.round((totalDeployed / totalActive) * 100) : 0;
            const totalIdle = modelStats.reduce((s, m) => s + m.idle_units, 0);

            // Strip idle_serials from per-model list (they come from allIdleSerials)
            const modelStatsClean = modelStats.map(({ idle_serials, ...rest }) => rest);

            return res.status(200).json({
                success: true,
                summary: {
                    total_fleet: totalFleet,
                    overall_utilization: overallUtilization,
                    total_idle: totalIdle,
                    total_deployed: totalDeployed,
                    total_stocked: modelStats.reduce((s, m) => s + m.stocked_units, 0),
                    total_repair: modelStats.reduce((s, m) => s + m.repair_units, 0),
                    total_scrapped: totalScrapped
                },
                model_stats: modelStatsClean,
                idle_serials: allIdleSerials
            });
        }

        return res.status(400).json({ message: 'Unknown action' });

    } catch (err) {
        console.error('Inventory Engine Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
