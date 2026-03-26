import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, payload, query } = body;

    try {
        // --- ACTION: DELETE (Reset Equipment + Log Activity) ---
        if (action === 'delete') {
            const { deployment_id, equipment_id, merchant_id, merchant_name, serial_number, user_email } = payload || {};

            if (equipment_id) {
                await supabase.from('equipments').update({ 
                    status: 'stocked', 
                    current_location: 'Warsaw Office',
                    merchant_id: null 
                }).eq('id', equipment_id);

                await supabase.from('equipment_logs').insert([{
                    equipment_id: equipment_id,
                    merchant_id: merchant_id,
                    action: 'Ticket Deleted',
                    from_location: merchant_name || 'Merchant Site',
                    to_location: 'Warsaw Office',
                    notes: `Deployment ticket ${deployment_id} deleted. Unit returned to stock.`
                }]);
            }

            await supabase.from('deployments').delete().eq('id', deployment_id);

            await supabase.from('activity_logs').insert([{
                email: user_email || 'admin@secureconsole.com',
                action: 'DELETE_DEPLOYMENT',
                status: 'Success',
                details: `Deleted ticket ${deployment_id} for ${merchant_name}. HW ${serial_number} reset to Stock.`
            }]);

            return res.status(200).json({ success: true });
        }
        
        // --- ACTION: LIST (With Fix for Search & KPI Metrics) ---
        if (action === 'list') {
            const { query, page = 1, limit = 10 } = body;
            const from = (page - 1) * limit;
            const to = from + limit - 1;

            let request = supabase
                .from('deployments')
                .select(`
                    *,
                    merchants:merchant_id(dba_name, merchant_id),
                    equipments:equipment_id(id, serial_number, terminal_type)
                `, { count: 'exact' });

            if (query) {
                const term = `%${query}%`;
                const { data: matchedEquip } = await supabase
                    .from('equipments')
                    .select('id')
                    .ilike('serial_number', term);

                const equipIds = (matchedEquip || []).map(e => e.id);

                if (equipIds.length > 0) {
                    request = request.or(`deployment_id.ilike.${term},equipment_id.in.(${equipIds.join(',')})`);
                } else {
                    request = request.ilike('deployment_id', term);
                }
            }

            const { data, error, count } = await request
                .order('created_at', { ascending: false })
                .range(from, to);

            if (error) throw error;

            // SURGICAL FIX: Fetch real counts from the database for KPIs
            // 1. Get Active Count (Open or In Transit)
            const { count: activeCount } = await supabase
                .from('deployments')
                .select('*', { count: 'exact', head: true })
                .in('status', ['Open', 'In Transit']);

            // 2. Get Today's Count
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);
            const { count: todayCount } = await supabase
                .from('deployments')
                .select('*', { count: 'exact', head: true })
                .gte('created_at', startOfDay.toISOString());

            const safeData = data || [];
            const metrics = {
                active: activeCount || 0,
                total: count || 0,
                today: todayCount || 0
            };
            
            return res.status(200).json({ 
                success: true, 
                data: safeData, 
                metrics,
                pagination: {
                    totalRecords: count,
                    currentPage: page,
                    totalPages: Math.ceil((count || 0) / limit)
                }
            });
        }

        // --- ACTION: CREATE ---
        if (action === 'create') {
            const { merchant_id, equipment_id, tid, tracking_id, target_date, notes } = payload;
            const { data: merchantData } = await supabase.from('merchants').select('dba_name').eq('id', merchant_id).single();
            const dbaName = merchantData?.dba_name || 'Client Site';

            const { data: newDep, error: depError } = await supabase
                .from('deployments')
                .insert([{ merchant_id, equipment_id, tid, tracking_id, target_deployment_date: target_date, notes, status: 'Open' }]).select();

            if (depError) throw depError;

            await supabase.from('equipments').update({ status: 'deployed', current_location: dbaName, merchant_id }).eq('id', equipment_id);

            await supabase.from('equipment_logs').insert([{
                equipment_id, merchant_id, action: 'Deployed', from_location: 'Warsaw Office', to_location: dbaName, notes: `Deployment Created. TID: ${tid}`
            }]);

            return res.status(200).json({ success: true, data: newDep });
        }

        // --- ACTION: RETURN TO OFFICE ---
        if (action === 'return_to_office') {
            const { equipment_id, merchant_id, deployment_id, notes, return_type } = payload;

            const { data: merchantData } = await supabase.from('merchants').select('dba_name').eq('id', merchant_id).single();
            const dbaName = merchantData?.dba_name || 'Merchant Field';

            await supabase.from('returns').insert([{
                merchant_id, equipment_id, status: 'open', condition: return_type,
                return_reason: notes || 'Returned from field',
                destination: return_type === 'Defective' ? 'Warsaw Repairs' : 'Warsaw Office'
            }]);

            await supabase.from('equipments').update({ 
                status: 'pending_return', current_location: 'In Transit / RMA', merchant_id: null 
            }).eq('id', equipment_id);

            await supabase.from('deployments').update({ status: 'Closed' }).eq('id', deployment_id);

            await supabase.from('equipment_logs').insert([{
                equipment_id, merchant_id, action: 'Initiated Return', from_location: dbaName,
                to_location: 'In Transit / RMA', notes: `RMA Started. Condition: ${return_type}. Notes: ${notes}`
            }]);

            return res.status(200).json({ success: true });
        }

        // --- ACTION: UPDATE (With Tracking/Status Logs) ---
        if (action === 'update') {
            const { deployment_id, status, tracking_id, target_date, notes } = payload;

            const { data: oldDep } = await supabase.from('deployments').select(`
                status, tracking_id, equipment_id, merchants:merchant_id(dba_name)
            `).eq('id', deployment_id).single();

            const { error: updateError } = await supabase.from('deployments').update({ 
                status, tracking_id, target_deployment_date: target_date, notes 
            }).eq('id', deployment_id);

            if (updateError) throw updateError;

            if (oldDep && (oldDep.status !== status || oldDep.tracking_id !== tracking_id)) {
                await supabase.from('equipment_logs').insert([{
                    equipment_id: oldDep.equipment_id,
                    action: 'Ticket Updated',
                    from_location: oldDep.merchants?.dba_name || 'Merchant',
                    to_location: oldDep.merchants?.dba_name || 'Merchant',
                    notes: `Status changed to ${status}. Tracking: ${tracking_id || 'N/A'}`
                }]);
            }

            if (status === 'Closed' && oldDep?.equipment_id) {
                await supabase.from('equipments').update({ status: 'deployed' }).eq('id', oldDep.equipment_id);
            }

            return res.status(200).json({ success: true });
        }

        // --- ACTION: LOOKUPS (Updated for MID + DBA search) ---
if (action === 'getLookups') {
    const term = `%${query || ''}%`;

    // Search BOTH dba_name and merchant_id
    const { data: merchants } = await supabase
        .from('merchants')
        .select('id, dba_name, merchant_id')
        .or(`dba_name.ilike.${term},merchant_id.ilike.${term}`) 
        .limit(10); // Increased limit for better selection

    const { data: inventory } = await supabase
        .from('equipments')
        .select('id, serial_number, terminal_type, status')
        .eq('status', 'stocked')
        .ilike('serial_number', term)
        .limit(10);

    return res.status(200).json({ merchants, inventory });
}

        // --- ACTION: HISTORY ---
        if (action === 'getHistory') {
            const { data, error } = await supabase.from('equipment_logs').select('*').eq('equipment_id', body.equipment_id).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) { 
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message }); 
    }
}
