import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const RETURN_SCHEMA = "69a314e9fe810d7f8614e1ce";
    const RETURN_ASSOC_ID = "69a3151e5767c05d16488ab9"; 

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, payload, userEmail, gearID, schemaType, prefix } = req.body;

    try {
        // --- CREATE RETURN (STRICT POSTMAN MAPPING) ---
        if (action === 'createReturn') {
            const resRet = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": RETURN_SCHEMA }, 
                body: JSON.stringify({ 
                    locationId: LOCATION_ID, 
                    properties: payload // Payload now contains full keys from frontend
                }) 
            });
            const newRet = await resRet.json();
            const newRetId = newRet.id || newRet.record?.id;

            if (newRetId) {
                // Link Equipment to Return using Equipment Record ID first
                await fetch(PROXY_URL, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                    body: JSON.stringify({ 
                        locationId: LOCATION_ID, associationId: RETURN_ASSOC_ID, 
                        firstRecordId: gearID, secondRecordId: newRetId 
                    }) 
                });
                return res.status(200).json({ success: true });
            }
            throw new Error("Record rejected by GHL");
        }

        // --- GET NEXT ID (SUPPORTING FULL KEYS) ---
        if (action === 'getNextID') {
            const resID = await fetch(PROXY_URL, { method: "POST", headers: { "Schema-Id": schemaType }, body: JSON.stringify({ locationId: LOCATION_ID, page: 1, pageLimit: 20 }) });
            const d = await resID.json();
            let max = 0;
            (d.records || []).forEach(r => {
                const p = r.properties || {};
                // Check both standard and full property keys
                const idVal = p["custom_objects.returns.return_id"] || p.return_id || p.equipment_id || "";
                const num = parseInt(idVal.replace(/\D/g, ''));
                if (!isNaN(num) && num > max) max = num;
            });
            return res.status(200).json({ nextID: `${prefix}${(max + 1).toString().padStart(7, '0')}` });
        }
        
        // ... (Keep existing Create Equipment, Create Deployment, and List actions)

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
