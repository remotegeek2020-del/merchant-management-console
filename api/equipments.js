import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const DEPLOYMENT_SCHEMA = "69a19ca47e855c2e654a44f7"; // Re-verify this ID if needed
    const RETURN_SCHEMA = "69a314e9fe810d7f8614e1ce";

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, payload, userEmail, merchantID } = req.body;

    const logAction = async (msg) => {
        try {
            await supabase.from('activity_logs').insert([{
                email: userEmail || 'System', action: msg, status: 'SUCCESS', ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
            }]);
        } catch (e) {}
    };

    try {
        if (action === 'list') {
            const resData = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Schema-Id": req.body.schemaId || EQUIPMENT_SCHEMA, "Content-Type": "application/json" }, 
                body: JSON.stringify({ locationId: LOCATION_ID, page: 1, pageLimit: 15, query: req.body.query }) 
            });
            const data = await resData.json();
            return res.status(200).json({ success: true, records: data.records || [] });
        }

        if (action === 'createEquipment') {
            const resEq = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, 
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) 
            });
            const d = await resEq.json();
            if ((d.id || d.record?.id) && merchantID) {
                // Link to Merchant logic here if needed
            }
            await logAction(`Equipment Received: ${payload["custom_objects.equipments.equipment_id"]}`);
            return res.status(200).json({ success: true });
        }
        
        // Add other actions as needed (getNextID, etc)
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
