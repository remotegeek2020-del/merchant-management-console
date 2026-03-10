import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const DEPLOYMENT_SCHEMA = "69a19c2a7134dc2f8d6988ef";
    const RETURN_SCHEMA = "69a314e9fe810d7f8614e1ce";
    const ASSOC_ID = "6728643af1853631d21b97af"; 

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, payload, userEmail, merchantID, internalId, query, prefix } = req.body;

    const logAction = async (msg) => {
        try {
            await supabase.from('activity_logs').insert([{
                email: userEmail || 'System', action: msg, status: 'SUCCESS', ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
            }]);
        } catch (e) {}
    };

    try {
        // --- ACTION: GET NEXT ID ---
        if (action === 'getNextID') {
            let target = prefix === 'DPL-' ? DEPLOYMENT_SCHEMA : (prefix === 'RTR-' ? RETURN_SCHEMA : EQUIPMENT_SCHEMA);
            const resID = await fetch(PROXY_URL, { method: "POST", headers: { "Schema-Id": target }, body: JSON.stringify({ locationId: LOCATION_ID, page: 1, pageLimit: 20 }) });
            const d = await resID.json();
            let max = 0;
            (d.records || []).forEach(r => {
                const p = r.properties || {};
                // Checks both long and short keys for ID calculation
                const idVal = p["custom_objects.equipments.equipment_id"] || p.equipment_id || "";
                const num = parseInt(idVal.replace(/\D/g, ''));
                if (!isNaN(num) && num > max) max = num;
            });
            if (max === 0 && prefix === 'Equip-') max = 108039;
            return res.status(200).json({ nextID: `${prefix}${(max + 1).toString().padStart(7, '0')}` });
        }

        // --- ACTION: CREATE EQUIPMENT (The Fix) ---
        if (action === 'createEquipment') {
            // CRITICAL: We pass the payload (containing full keys) directly into properties
            const resEq = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, 
                body: JSON.stringify({ 
                    locationId: LOCATION_ID, 
                    properties: payload 
                }) 
            });
            const d = await resEq.json();
            const newId = d.id || d.record?.id;

            if (newId && merchantID) {
                // Link the new Equipment to the Merchant Location
                await fetch(PROXY_URL, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                    body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: newId, secondRecordId: merchantID }) 
                });
            }
            await logAction(`Equipment Created: ${payload["custom_objects.equipments.equipment_id"]}`);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: LIST ---
        if (action === 'list') {
            const resData = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Schema-Id": req.body.schemaId || EQUIPMENT_SCHEMA, "Content-Type": "application/json" }, 
                body: JSON.stringify({ locationId: LOCATION_ID, page: 1, pageLimit: 15, query: query }) 
            });
            const data = await resData.json();
            return res.status(200).json({ success: true, records: data.records || [] });
        }

        // --- ACTION: HYDRATION ---
        if (action === 'getHydratedData') {
            const relRes = await fetch(`${PROXY_URL}relations/${internalId}?locationId=${LOCATION_ID}`);
            const relData = await relRes.json();
            const rel = (relData.relations || []).find(r => r.secondObjectKey.includes(EQUIPMENT_SCHEMA) || r.firstObjectKey.includes(EQUIPMENT_SCHEMA));
            if (rel) {
                const eqId = (rel.firstRecordId === internalId) ? rel.secondRecordId : rel.firstRecordId;
                const eqRes = await fetch(`${PROXY_URL}custom_objects.equipments/records/${eqId}?locationId=${LOCATION_ID}`, { headers: { "Schema-Id": EQUIPMENT_SCHEMA } });
                const eqData = await eqRes.json();
                return res.status(200).json({ success: true, data: eqData.record?.properties || eqData.properties });
            }
            return res.status(404).json({ success: false });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
