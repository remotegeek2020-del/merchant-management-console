import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, equipment_id, payload } = req.body;

    try {
        // --- 1. LIST ALL DEPLOYMENTS ---
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

        // --- 2. GET LOOKUPS (Merchants & Available Office Inventory) ---
        if (action === 'getLookups') {
            // Enhanced Merchant Search logic
            let merchantBuilder = supabase.from('merchants').select('id, dba_name').order('dba_name');
            if (query) {
                merchantBuilder = merchantBuilder.ilike('dba_name', `%${query}%`);
            }

            const [merchants, inventory] = await Promise.all([
                merchantBuilder.limit(20), // Limit results for faster UI response
                // Broadened hardware lookup: catches common variations of "In Stock"
                supabase.from('equipments')
                    .select('id, serial_number, terminal_type, status')
                    .or('status.ilike.Office,status.ilike.In Stock,status.ilike.Inventory,status.ilike.In-Office,status.ilike.Available,status.is.null')
            ]);

            if (merchants.error) throw merchants.error;
            if (inventory.error) throw inventory.error;

            // Debug fallback: If no "Office" items found, return all non-deployed items as a safeguard
            let finalInventory = inventory.data || [];
            if (finalInventory.length === 0) {
                const fallback = await supabase.from('equipments')
                    .select('id, serial_number, terminal_type, status')
                    .neq('status', 'Deployed')
                    .limit(50);
                finalInventory = fallback.data || [];
            }

            return res.status(200).json({ 
                success: true, 
                merchants: merchants.data || [], 
                inventory: finalInventory
            });
        }

        // --- 3. CREATE NEW DEPLOYMENT ---
        if (action === 'create') {
            const { merchant_id, equipment_id, tid, tracking_id, target_date, notes } = payload;

            const { data: depData, error: depError } = await supabase
                .from('deployments')
                .insert([{
                    merchant_id,
                    equipment_id,
                    tid,
                    tracking_id,
                    target_deploymer: target_date,
                    status: 'Open',
                    notes
                }])
                .select();

            if (depError) throw depError;

            await supabase
                .from('equipments')
                .update({ status: 'Deployed' })
                .eq('id', equipment_id);

            const { data: mData } = await supabase.from('merchants').select('dba_name').eq('id', merchant_id).single();
            
            await supabase.from('equipment_logs').insert([{
                equipment_id,
                merchant_id,
                deployment_id: depData[0].id,
                action: 'Deployed',
                from_location: 'Warsaw Office',
                to_location: mData?.dba_name || 'Merchant',
                notes: notes || `Initial deployment. Ticket ID: ${depData[0].deployment_id || 'N/A'}`
            }]);

            return res.status(200).json({ success: true, message: "Deployment created successfully" });
        }

        // --- 4. FETCH EQUIPMENT HISTORY ---
        if (action === 'getHistory') {
            if (!equipment_id) return res.status(400).json({ message: "Equipment ID required" });

            const { data, error } = await supabase
                .from('equipment_logs')
                .select(`*, merchants (dba_name)`)
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
