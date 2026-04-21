import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, payload, query, equipment_id } = body; // Standardized destructuring

    try {
        // --- ACTION: LOG RETURN ---
        if (action === 'log_return') {
            const { equipment_id, merchant_id, deployment_id, reason, notes, return_date_initiated } = payload;
            const { error: returnError } = await supabase.from('returns').insert([{
                equipment_id, merchant_id, deployment_id, return_reason: reason, notes, return_date_initiated, status: 'open'
            }]);
            if (returnError) throw returnError;
            await supabase.from('equipment_logs').insert([{
                equipment_id, merchant_id, action: 'return_initiated', from_location: 'Merchant Site', to_location: 'In Transit', notes: `Return initiated: ${reason}`
            }]);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: COMPLETE RMA ---
        else if (action === 'complete_rma') {
            const { return_id, equipment_id, destination, equipment_received_date } = payload;
            const { error: updateReturnError } = await supabase.from('returns').update({ 
                status: 'completed', destination, equipment_received_date 
            }).eq('id', return_id);
            if (updateReturnError) throw updateReturnError;
            const { error: equipError } = await supabase.from('equipments').update({ 
                status: 'stocked', current_location: destination, merchant_id: null 
            }).eq('id', equipment_id);
            if (equipError) throw equipError;
            await supabase.from('equipment_logs').insert([{
                equipment_id, action: 'rma_completed', from_location: 'In Transit', to_location: destination, notes: `RMA Closed. Received on ${equipment_received_date}`
            }]);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET MONTHLY REPORT ---
        else if (action === 'getMonthlyReport') {
            const { startDate, endDate, offset = 0, limit = 1000 } = body;
            const { data, error, count } = await supabase.from('deployments').select(`
                deployment_id, tid, tracking_id, target_deployment_date, status, purchase_type,
                merchants:merchant_id (dba_name, merchant_id),
                equipments:equipment_id (serial_number, terminal_type)
            `, { count: 'exact' }).gte('target_deployment_date', startDate).lte('target_deployment_date', endDate)
            .range(offset, offset + limit - 1).order('target_deployment_date', { ascending: false });
            if (error) throw error;
            const rawData = data.map(d => ({
                "Deployment ID": d.deployment_id, "Date": d.target_deployment_date, "Merchant ID": d.merchants?.merchant_id || 'N/A',
                "Merchant Name": d.merchants?.dba_name || 'N/A', "Serial": d.equipments?.serial_number || 'N/A',
                "Model": d.equipments?.terminal_type || 'N/A', "TID": d.tid || 'N/A', "Purchase Type": d.purchase_type || '---', "Status": d.status
            }));
            return res.status(200).json({ success: true, rawData, totalCount: count });
        }

        // --- ACTION: UPDATE ---
        else if (action === 'update') {
            const { deployment_id, status, tracking_id, target_date, notes, purchase_type } = payload;
            const { data: oldDep, error: fetchError } = await supabase.from('deployments').select('status, tracking_id, equipment_id, merchant_id').eq('id', deployment_id).single();
            if (fetchError || !oldDep) return res.status(404).json({ success: false, message: "Ticket not found." });
            const { error: updateError } = await supabase.from('deployments').update({ 
                status, tracking_id, target_deployment_date: target_date, notes, purchase_type 
            }).eq('id', deployment_id);
            if (updateError) throw updateError;
            if (oldDep.status !== status || oldDep.tracking_id !== tracking_id) {
                await supabase.from('equipment_logs').insert([{
                    equipment_id: oldDep.equipment_id, merchant_id: oldDep.merchant_id, deployment_id, action: 'TICKET_UPDATED',
                    from_location: 'Merchant Site', to_location: 'Merchant Site', notes: `Status changed to ${status}. Purchase Type: ${purchase_type || 'N/A'}`
                }]);
            }
            return res.status(200).json({ success: true });
        }

        // --- ACTION: CHECK RMA ---
        else if (action === 'check_rma') {
            const { deployment_id } = payload;
            const { data, error } = await supabase.from('returns').select('return_id, id, status, return_reason').eq('deployment_id', deployment_id).maybeSingle();
            return res.status(200).json({ success: true, data: data || null });
        }

        // --- ACTION: DELETE ---
        else if (action === 'delete') {
            const { deployment_id, equipment_id, merchant_id, merchant_name } = payload || {};
            if (!deployment_id) return res.status(400).json({ success: false, message: "Missing ID" });
            await supabase.from('returns').delete().eq('deployment_id', deployment_id);
            if (equipment_id) {
                await supabase.from('equipments').update({ status: 'stocked', current_location: 'Warsaw Office', merchant_id: null }).eq('id', equipment_id);
                await supabase.from('equipment_logs').insert([{
                    equipment_id, merchant_id, action: 'TICKET_DELETED', from_location: merchant_name || 'Merchant Site', to_location: 'Warsaw Office', notes: `Ticket ${deployment_id} deleted.`
                }]);
            }
            const { error: deleteError } = await supabase.from('deployments').delete().eq('id', deployment_id);
            if (deleteError) throw deleteError;
            return res.status(200).json({ success: true });
        }

        // --- ACTION: LIST ---
        else if (action === 'list') {
            const { query, page = 1, limit = 10 } = body;
            const from = (page - 1) * limit;
            const to = from + limit - 1;
            let request = supabase.from('deployments').select(`*, merchants:merchant_id(dba_name, merchant_id), equipments:equipment_id(id, serial_number, terminal_type)`, { count: 'exact' });
            if (query) {
                const term = `%${query}%`;
                const { data: matchedEquip } = await supabase.from('equipments').select('id').ilike('serial_number', term);
                const equipIds = (matchedEquip || []).map(e => e.id);
                if (equipIds.length > 0) request = request.or(`deployment_id.ilike.${term},equipment_id.in.(${equipIds.join(',')})`);
                else request = request.ilike('deployment_id', term);
            }
            const { data, error, count } = await request.order('created_at', { ascending: false }).range(from, to);
            if (error) throw error;
            const { count: activeCount } = await supabase.from('deployments').select('*', { count: 'exact', head: true }).in('status', ['Open', 'In Transit']);
            const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
            const { count: todayCount } = await supabase.from('deployments').select('*', { count: 'exact', head: true }).gte('created_at', startOfDay.toISOString());
            return res.status(200).json({ success: true, data: data || [], metrics: { active: activeCount || 0, total: count || 0, today: todayCount || 0 }, pagination: { totalRecords: count, currentPage: page, totalPages: Math.ceil((count || 0) / limit) } });
        }

        // --- ACTION: CREATE ---
        else if (action === 'create') {
            const { merchant_id, equipment_id, tid, tracking_id, target_date, notes, purchase_type } = payload;
            const { data: checkEquip, error: checkError } = await supabase.from('equipments').select('status, serial_number').eq('id', equipment_id).single();
            if (checkError || !checkEquip) throw new Error("Equipment not found.");
            if (checkEquip.status !== 'stocked') return res.status(400).json({ success: false, message: `Serial ${checkEquip.serial_number} is not in stock.` });
            const { data: merchantData } = await supabase.from('merchants').select('dba_name').eq('id', merchant_id).single();
            const dbaName = merchantData?.dba_name || 'Client Site';
            const { data: newDep, error: depError } = await supabase.from('deployments').insert([{ 
                merchant_id, equipment_id, tid, tracking_id, target_deployment_date: target_date, notes, purchase_type, status: 'Open' 
            }]).select();
            if (depError) throw depError;
            await supabase.from('equipments').update({ status: 'deployed', current_location: dbaName, merchant_id }).eq('id', equipment_id);
            await supabase.from('equipment_logs').insert([{
                equipment_id, merchant_id, action: 'Deployed', from_location: 'Warsaw Office', to_location: dbaName, notes: `Deployment Created. Type: ${purchase_type || 'N/A'}`
            }]);
            return res.status(200).json({ success: true, data: newDep });
        }

        // --- ACTION: RETURN TO OFFICE ---
        else if (action === 'return_to_office') {
            const { equipment_id, merchant_id, deployment_id, return_type, notes, return_date_initiated, equipment_received_date } = payload;
            if (return_type === 'In Transit') {
                const { error } = await supabase.from('returns').upsert({
                    deployment_id, equipment_id, merchant_id, return_reason: notes, return_date_initiated, condition: 'IN TRANSIT', destination: 'In Transit / RMA', status: 'Open'
                }, { onConflict: 'deployment_id' });
                if (error) throw error;
            } else {
                let finalCondition = return_type === 'Working (Back to Stock)' ? 'Working (Back to Stock)' : 'Defective (Received in Repairs)';
                let finalDestination = return_type === 'Working (Back to Stock)' ? 'Warsaw Office' : 'Warsaw Repairs';
                const { error: rUpdateErr } = await supabase.from('returns').update({ status: 'Closed', condition: finalCondition, destination: finalDestination, equipment_received_date }).eq('deployment_id', deployment_id);
                if (rUpdateErr) throw rUpdateErr;
                await supabase.from('equipments').update({ status: 'stocked', current_location: finalDestination, merchant_id: null }).eq('id', equipment_id);
            }
            return res.status(200).json({ success: true });
        }

        // --- ACTION: LOOKUPS ---
        else if (action === 'getLookups') {
            const term = `%${query || ''}%`;
            const { data: merchants } = await supabase.from('merchants').select('id, dba_name, merchant_id').or(`dba_name.ilike.${term},merchant_id.ilike.${term}`).limit(10);
            const { data: inventory } = await supabase.from('equipments').select('id, serial_number, terminal_type, status').eq('status', 'stocked').ilike('serial_number', term).limit(10);
            return res.status(200).json({ merchants, inventory });
        }

        // --- ACTION: HISTORY ---
        else if (action === 'getHistory') {
            const targetId = body.equipment_id || payload?.equipment_id;
            const { data, error } = await supabase.from('equipment_logs').select('*').eq('equipment_id', targetId).order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
