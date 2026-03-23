import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, equipment_id, payload } = req.body;

    try {
        // --- ACTION: LIST DEPLOYMENTS ---
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

        // --- ACTION: GET LOOKUPS (Merchant Search & Office Inventory) ---
        if (action === 'getLookups') {
            let merchantBuilder = supabase.from('merchants').select('id, dba_name, merchant_id').order('dba_name');
            
            if (query) {
                // Searches BOTH DBA Name and Merchant ID
                merchantBuilder = merchantBuilder.or(`dba_name.ilike.%${query}%,merchant_id.ilike.%${query}%`);
            }

            const [merchants, inventory] = await Promise.all([
                merchantBuilder.limit(50), 
                supabase.from('equipments')
                    .select('id, serial_number, terminal_type, status')
                    .or('status.ilike.Office,status.ilike.In Stock,status.ilike.Inventory,status.is.null')
            ]);

            let finalInventory = inventory.data || [];
            if (finalInventory.length === 0) {
                const fallback = await supabase.from('equipments')
                    .select('id, serial_number, terminal_type, status')
                    .neq('status', 'Deployed').limit(100);
                finalInventory = fallback.data || [];
            }

            return res.status(200).json({ success: true, merchants: merchants.data || [], inventory: finalInventory });
        }

  // --- ACTION: CREATE DEPLOYMENT (Updated to lowercase 'deployed') ---
if (action === 'create') {
    const { merchant_id, equipment_id, tid, tracking_id, target_date, notes } = payload;
    
    // 1. Fetch Merchant Name for Location
    const { data: mData, error: mError } = await supabase
        .from('merchants')
        .select('dba_name')
        .eq('id', merchant_id)
        .single();
    
    if (mError) throw mError;
    const merchantDBA = mData?.dba_name || 'Merchant';

    // 2. Create the Deployment Ticket
    const { data: depData, error: depError } = await supabase.from('deployments').insert([{
        merchant_id, 
        equipment_id, 
        tid, 
        tracking_id, 
        target_deployment_date: target_date, 
        status: 'Open', 
        notes: notes || ''
    }]).select();
    
    if (depError) throw depError;

    // 3. UPDATE EQUIPMENT TABLE (Fixed to lowercase 'deployed')
    const { error: equipUpdateError } = await supabase
        .from('equipments')
        .update({ 
            status: 'deployed', // Changed from 'Deployed' to 'deployed'
            merchant_id: merchant_id,
            current_location: merchantDBA
        })
        .eq('id', equipment_id);

    if (equipUpdateError) throw equipUpdateError;

    // 4. Log History Entry
    await supabase.from('equipment_logs').insert([{
        equipment_id, 
        merchant_id, 
        deployment_id: depData[0].id,
        action: 'deployed', // Consistent lowercase
        from_location: 'Warsaw Office',
        to_location: merchantDBA, 
        notes: notes || 'New Deployment Ticket Created'
    }]);

    return res.status(200).json({ success: true });
}

    // 3. UPDATE EQUIPMENT TABLE: Link to Merchant, flip Status, AND Update Location
    const { error: equipUpdateError } = await supabase
        .from('equipments')
        .update({ 
            status: 'Deployed',
            merchant_id: merchant_id,
            current_location: merchantDBA // FIX: Explicitly setting the location to the Merchant Name
        })
        .eq('id', equipment_id);

    if (equipUpdateError) throw equipUpdateError;

    // 4. Log History Entry
    await supabase.from('equipment_logs').insert([{
        equipment_id, 
        merchant_id, 
        deployment_id: depData[0].id,
        action: 'Deployed', 
        from_location: 'Warsaw Office',
        to_location: merchantDBA, 
        notes: notes || 'New Deployment Ticket Created'
    }]);

    return res.status(200).json({ success: true });
}
        // --- ACTION: HISTORY ---
        if (action === 'getHistory') {
            const { data, error } = await supabase.from('equipment_logs')
                .select(`*, merchants(dba_name)` )
                .eq('equipment_id', equipment_id)
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }
    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
