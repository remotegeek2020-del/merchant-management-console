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
        .select('email, first_name, last_name, role')
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
            if (actor?.role !== 'super_admin') {
                return res.status(403).json({ success: false, message: 'Only Super Admins can delete equipment.' });
            }
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
        


        if (action === 'bulk_create') {
            const { serials, terminal_type, received_date, status, current_location } = req.body;
            if (!Array.isArray(serials) || !serials.length) {
                return res.status(400).json({ success: false, message: 'No serial numbers provided.' });
            }

            // Auto-register unknown terminal type
            if (terminal_type) {
                const { data: existingType } = await supabase
                    .from('terminal_types').select('id').eq('name', terminal_type).maybeSingle();
                if (!existingType) {
                    const { data: maxRow } = await supabase
                        .from('terminal_types').select('sort_order').order('sort_order', { ascending: false }).limit(1).single();
                    await supabase.from('terminal_types')
                        .insert({ name: terminal_type, sort_order: ((maxRow?.sort_order || 0) + 10) });
                }
            }
            // Deduplicate and trim
            const unique = [...new Set(serials.map(s => String(s).trim()).filter(Boolean))];

            // Check which ones already exist
            const { data: existing } = await supabase
                .from('equipments')
                .select('serial_number')
                .in('serial_number', unique);
            const existingSet = new Set((existing || []).map(e => e.serial_number));
            const newSerials  = unique.filter(s => !existingSet.has(s));
            const skipped     = unique.filter(s =>  existingSet.has(s));

            let inserted = [];
            if (newSerials.length) {
                const rows = newSerials.map(serial_number => ({
                    serial_number,
                    terminal_type: terminal_type || 'Unknown',
                    received_date: received_date || null,
                    status: status || 'stocked',
                    current_location: current_location || 'Warsaw Office'
                }));
                const { data: insertedData, error: insertError } = await supabase
                    .from('equipments')
                    .insert(rows)
                    .select();
                if (insertError) throw insertError;
                inserted = insertedData || [];

                // Log one activity entry for the bulk operation
                supabase.from('activity_logs').insert([{
                    email: actorEmail,
                    action: `Bulk Inventory Added — ${inserted.length} ${terminal_type} unit${inserted.length !== 1 ? 's' : ''}`,
                    status: 'success', category: 'inventory', target_type: 'equipment', severity: 'info',
                    new_value: { count: inserted.length, terminal_type, serial_numbers: newSerials, skipped },
                    user_agent: req.headers['user-agent'],
                    ip_address: req.headers['x-forwarded-for'] || 'internal'
                }]).then(() => {}).catch(() => {});
            }

            return res.status(200).json({
                success: true,
                inserted: inserted.length,
                skipped_duplicates: skipped,
                data: inserted
            });
        }

        if (action === 'create') {
            // Auto-register unknown terminal type
            if (payload?.terminal_type) {
                const { data: existing } = await supabase
                    .from('terminal_types').select('id').eq('name', payload.terminal_type).maybeSingle();
                if (!existing) {
                    const { data: maxRow } = await supabase
                        .from('terminal_types').select('sort_order').order('sort_order', { ascending: false }).limit(1).single();
                    await supabase.from('terminal_types')
                        .insert({ name: payload.terminal_type, sort_order: ((maxRow?.sort_order || 0) + 10) });
                }
            }

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
            // Paginate — bypass Supabase 1000-row cap
            let allRepair = [];
            let from = 0;
            const PAGE = 1000;
            while (true) {
                const { data, error } = await supabase
                    .from('equipments')
                    .select('id, serial_number, terminal_type, status, current_location, condition, received_date, repair_notes, repair_stage')
                    .eq('current_location', 'Warsaw Repairs')
                    .order('received_date', { ascending: true })
                    .range(from, from + PAGE - 1);
                if (error) throw error;
                if (!data || data.length === 0) break;
                allRepair = allRepair.concat(data);
                if (data.length < PAGE) break;
                from += PAGE;
            }

            const now = new Date();
            const CRITICAL_DAYS = 14;

            // Enrich each unit with computed fields
            const enriched = allRepair.map(u => {
                const refDate = u.received_date || u.created_at;
                const days_in_repair = refDate
                    ? Math.floor((now - new Date(refDate)) / (1000 * 60 * 60 * 24))
                    : null;
                return { ...u, days_in_repair };
            });

            // Summary stats
            const stageCounts = { Received: 0, Diagnosis: 0, 'Under Repair': 0, Testing: 0, Other: 0 };
            const modelCounts = {};
            let totalDays = 0, daysCount = 0, criticalCount = 0;
            for (const u of enriched) {
                const stage = u.repair_stage || 'Received';
                if (stageCounts.hasOwnProperty(stage)) stageCounts[stage]++;
                else stageCounts.Other++;
                modelCounts[u.terminal_type || 'Unknown'] = (modelCounts[u.terminal_type || 'Unknown'] || 0) + 1;
                if (u.days_in_repair !== null) { totalDays += u.days_in_repair; daysCount++; }
                if (u.days_in_repair !== null && u.days_in_repair > CRITICAL_DAYS) criticalCount++;
            }

            return res.status(200).json({
                success: true,
                data: enriched,
                summary: {
                    total: enriched.length,
                    critical_count: criticalCount,
                    avg_days_in_repair: daysCount > 0 ? Math.round(totalDays / daysCount) : 0,
                    stage_counts: stageCounts,
                    model_counts: modelCounts,
                    critical_threshold_days: CRITICAL_DAYS
                }
            });
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
            const IDLE_THRESHOLD_DAYS = parseInt(req.body.idle_threshold_days) || 90;

            // Paginate through all equipment (Supabase default cap is 1000 rows)
            let allEquipment = [];
            let from = 0;
            const PAGE = 1000;
            while (true) {
                const { data, error } = await supabase
                    .from('equipments')
                    .select('id, serial_number, terminal_type, status, current_location, received_date, created_at')
                    .range(from, from + PAGE - 1);
                if (error) throw error;
                if (!data || data.length === 0) break;
                allEquipment = allEquipment.concat(data);
                if (data.length < PAGE) break;
                from += PAGE;
            }

            const now = new Date();

            // Group by terminal_type and build location map simultaneously
            const modelMap = {};
            const locationMap = {};

            for (const unit of allEquipment) {
                const model = unit.terminal_type || 'Unknown';
                const status = (unit.status || '').toLowerCase();
                const loc = unit.current_location || 'Unknown';

                if (!modelMap[model]) {
                    modelMap[model] = {
                        model,
                        total_units: 0, deployed_units: 0, stocked_units: 0,
                        repair_units: 0, scrapped_units: 0,
                        stocked_days_sum: 0, stocked_days_count: 0,
                        idle_units: 0, idle_serials: [],
                        age_buckets: { d0_30: 0, d31_60: 0, d61_90: 0, d91_180: 0, d180_plus: 0 }
                    };
                }
                // Exclude pseudo-locations — 'Client Site' is a fallback for deployed units
                // with no matched merchant DBA; 'Retired' is used for decommissioned stock.
                // Neither is a real physical inventory location.
                const EXCLUDED_LOCATIONS = new Set(['Client Site', 'Retired']);
                if (!EXCLUDED_LOCATIONS.has(loc)) {
                    if (!locationMap[loc]) {
                        locationMap[loc] = { location: loc, total: 0, deployed: 0, stocked: 0, repair: 0, scrapped: 0 };
                    }
                    const l = locationMap[loc];
                    l.total++;
                    if (status === 'deployed')                          l.deployed++;
                    else if (status === 'stocked')                      l.stocked++;
                    else if (status === 'repair' || status === 'repairing') l.repair++;
                    else if (status === 'decommissioned' || status === 'scrapped') l.scrapped++;
                }

                const m = modelMap[model];
                m.total_units++;

                if (status === 'deployed') {
                    m.deployed_units++;
                } else if (status === 'stocked') {
                    m.stocked_units++;
                    const stockDate = unit.received_date || unit.created_at;
                    if (stockDate) {
                        const d = new Date(stockDate);
                        if (!isNaN(d.getTime())) {
                            const days = Math.floor((now - d) / (1000 * 60 * 60 * 24));
                            m.stocked_days_sum += days;
                            m.stocked_days_count++;
                            // Age buckets
                            if (days <= 30) m.age_buckets.d0_30++;
                            else if (days <= 60) m.age_buckets.d31_60++;
                            else if (days <= 90) m.age_buckets.d61_90++;
                            else if (days <= 180) m.age_buckets.d91_180++;
                            else m.age_buckets.d180_plus++;

                            if (days > IDLE_THRESHOLD_DAYS) {
                                m.idle_units++;
                                m.idle_serials.push({
                                    serial_number: unit.serial_number,
                                    model,
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
                    age_buckets: m.age_buckets,
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

            const totalStocked = modelStats.reduce((s, m) => s + m.stocked_units, 0);
            const totalRepair  = modelStats.reduce((s, m) => s + m.repair_units, 0);

            // Aggregate stocked age buckets across all models
            const stockedAgeBuckets = modelStats.reduce((acc, m) => {
                acc.d0_30     += m.age_buckets.d0_30;
                acc.d31_60    += m.age_buckets.d31_60;
                acc.d61_90    += m.age_buckets.d61_90;
                acc.d91_180   += m.age_buckets.d91_180;
                acc.d180_plus += m.age_buckets.d180_plus;
                return acc;
            }, { d0_30: 0, d31_60: 0, d61_90: 0, d91_180: 0, d180_plus: 0 });

            // Location breakdown sorted by total desc
            const locationBreakdown = Object.values(locationMap)
                .sort((a, b) => b.total - a.total);

            return res.status(200).json({
                success: true,
                idle_threshold_days: IDLE_THRESHOLD_DAYS,
                summary: {
                    total_fleet: totalFleet,
                    overall_utilization: overallUtilization,
                    total_idle: totalIdle,
                    total_deployed: totalDeployed,
                    total_stocked: totalStocked,
                    total_repair: totalRepair,
                    total_scrapped: totalScrapped,
                    stocked_age_buckets: stockedAgeBuckets
                },
                model_stats: modelStatsClean,
                idle_serials: allIdleSerials,
                location_breakdown: locationBreakdown
            });
        }

        // --- TERMINAL TYPES MANAGEMENT ---

        if (action === 'list_terminal_types') {
            const { data, error } = await supabase
                .from('terminal_types')
                .select('id, name, sort_order, is_active')
                .order('sort_order', { ascending: true })
                .order('name', { ascending: true });
            if (error) throw error;
            return res.status(200).json({ success: true, terminal_types: data });
        }

        if (action === 'add_terminal_type') {
            const { name } = req.body;
            if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name is required.' });
            const { data: maxRow } = await supabase
                .from('terminal_types').select('sort_order').order('sort_order', { ascending: false }).limit(1).single();
            const nextOrder = ((maxRow?.sort_order || 0) + 10);
            const { error } = await supabase
                .from('terminal_types').insert({ name: name.trim(), sort_order: nextOrder });
            if (error) {
                if (error.code === '23505') return res.status(409).json({ success: false, message: 'Terminal type already exists.' });
                throw error;
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'update_terminal_type') {
            const { type_id, name, sort_order, is_active } = req.body;
            if (!type_id) return res.status(400).json({ success: false, message: 'type_id required.' });
            const patch = {};
            if (name !== undefined)       patch.name       = name.trim();
            if (sort_order !== undefined)  patch.sort_order  = sort_order;
            if (is_active !== undefined)   patch.is_active   = is_active;
            const { error } = await supabase.from('terminal_types').update(patch).eq('id', type_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'delete_terminal_type') {
            const { type_id } = req.body;
            if (!type_id) return res.status(400).json({ success: false, message: 'type_id required.' });
            const { error } = await supabase.from('terminal_types').delete().eq('id', type_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'count_by_terminal_type') {
            const { name } = req.body;
            if (!name) return res.status(400).json({ success: false, message: 'name required.' });
            const { count } = await supabase.from('equipments').select('id', { count: 'exact', head: true }).eq('terminal_type', name);
            return res.status(200).json({ success: true, count: count || 0 });
        }

        if (action === 'merge_terminal_type') {
            const { source_id, target_id } = req.body;
            if (!source_id || !target_id) return res.status(400).json({ success: false, message: 'source_id and target_id required.' });
            if (source_id === target_id) return res.status(400).json({ success: false, message: 'Source and target must be different.' });

            const [{ data: src }, { data: tgt }] = await Promise.all([
                supabase.from('terminal_types').select('id, name').eq('id', source_id).single(),
                supabase.from('terminal_types').select('id, name').eq('id', target_id).single()
            ]);
            if (!src) return res.status(404).json({ success: false, message: 'Source terminal type not found.' });
            if (!tgt) return res.status(404).json({ success: false, message: 'Target terminal type not found.' });

            // Count affected equipment before update
            const { count } = await supabase.from('equipments').select('id', { count: 'exact', head: true }).eq('terminal_type', src.name);

            // Rewrite terminal_type text on all equipment records
            const { error: updErr } = await supabase.from('equipments').update({ terminal_type: tgt.name }).eq('terminal_type', src.name);
            if (updErr) throw updErr;

            // Delete the source type
            const { error: delErr } = await supabase.from('terminal_types').delete().eq('id', source_id);
            if (delErr) throw delErr;

            supabase.from('activity_logs').insert({
                email: actorEmail,
                action: `Terminal type merged: "${src.name}" → "${tgt.name}" (${count || 0} unit${count !== 1 ? 's' : ''} updated)`,
                status: 'success', category: 'inventory', target_type: 'terminal_type', severity: 'warning',
                old_value: { type_id: source_id, name: src.name },
                new_value: { merged_into: tgt.name, equipment_updated: count || 0 }
            }).then(() => {}).catch(() => {});

            return res.status(200).json({ success: true, merged: count || 0, from: src.name, into: tgt.name });
        }

        if (action === 'request_terminal_type') {
            const { requested_name, notes } = req.body;
            if (!requested_name?.trim()) return res.status(400).json({ success: false, message: 'Terminal type name is required.' });

            // Get web developer email from site_settings
            const { data: setting } = await supabase
                .from('site_settings').select('value').eq('key', 'web_developer_email').single();
            const devEmail = setting?.value;
            if (!devEmail) return res.status(400).json({ success: false, message: 'Web developer email not configured in Portal CMS.' });

            if (process.env.POSTMARK_SERVER_TOKEN) {
                const { ServerClient } = await import('postmark');
                const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                await client.sendEmail({
                    From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
                    To: devEmail,
                    Subject: `Terminal Type Request: "${requested_name.trim()}"`,
                    HtmlBody: `<div style="font-family:Arial,sans-serif;max-width:580px;margin:0 auto;padding:36px 20px;">
                        <img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:32px;margin-bottom:24px;display:block;">
                        <h2 style="color:#002d5a;margin:0 0 16px;">New Terminal Type Request</h2>
                        <table style="width:100%;border-collapse:collapse;font-size:14px;">
                          <tr><td style="padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;color:#475569;width:140px;">Requested by</td>
                              <td style="padding:10px 14px;border:1px solid #e2e8f0;">${actorName} (${actorEmail})</td></tr>
                          <tr><td style="padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;color:#475569;">Terminal Type</td>
                              <td style="padding:10px 14px;border:1px solid #e2e8f0;font-weight:700;color:#002d5a;">${requested_name.trim()}</td></tr>
                          ${notes ? `<tr><td style="padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;color:#475569;">Notes</td>
                              <td style="padding:10px 14px;border:1px solid #e2e8f0;">${notes}</td></tr>` : ''}
                        </table>
                        <p style="margin:20px 0 0;font-size:13px;color:#64748b;">Add this terminal type via the <strong>Terminal Type Manager</strong> in Secret Dungeon.</p>
                        <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0;">
                        <p style="font-size:11px;color:#94a3b8;text-align:center;">PayProTec Operations Console</p>
                    </div>`,
                    TextBody: `Terminal Type Request\n\nRequested by: ${actorName} (${actorEmail})\nTerminal Type: ${requested_name.trim()}${notes ? `\nNotes: ${notes}` : ''}\n\nAdd via Terminal Type Manager in Secret Dungeon.`,
                    MessageStream: 'outbound'
                });
            }

            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ message: 'Unknown action' });

    } catch (err) {
        console.error('Inventory Engine Error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
