import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const DEPLOYMENT_SCHEMA = "69a19c2a7134dc2f8d6988ef";
    const RETURN_SCHEMA = "69a314e9fe810d7f8614e1ce";
    const ASSOC_ID = "6728643af1853631d21b97af"; 
    const DEPLOY_TO_GEAR_ASSOC = "69a19ca47e855c2e654a44f7"; 
    const RETURN_ASSOC_ID = "69a3151e5767c05d16488ab9"; 

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, view, page, limit, userEmail, gearID, merchantID, merchantName, schemaType, prefix } = req.body;

    const logAction = async (msg, status = 'SUCCESS') => {
        await supabase.from('activity_logs').insert([{
            email: userEmail || 'System', action: msg, status: status, ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
        }]);
    };

    try {
        // --- 1. CREATE RETURN (Fixed for Dropdown Compliance) ---
        if (action === 'createReturn') {
            // Force values to match GHL Dropdown labels exactly
            const formattedPayload = {
                ...payload,
                condition: payload.condition === 'good' ? 'Good' : 'Broken',
                return_status: 'open'
            };

            const resRet = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": RETURN_SCHEMA }, 
                body: JSON.stringify({ locationId: LOCATION_ID, properties: formattedPayload }) 
            });
            
            const newRet = await resRet.json();
            const newRetId = newRet.id || newRet.record?.id;

            if (newRetId) {
                // Link Gear to Return
                await fetch(PROXY_URL, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                    body: JSON.stringify({ 
                        locationId: LOCATION_ID, associationId: RETURN_ASSOC_ID, 
                        firstRecordId: gearID, secondRecordId: newRetId 
                    }) 
                });
                
                await logAction(`Return Logged: ${formattedPayload.return_id}`);
                return res.status(200).json({ success: true });
            }
            return res.status(400).json({ success: false, message: "GoHighLevel rejected the Return record." });
        }

        // --- 2. GET NEXT ID ---
        if (action === 'getNextID') {
            const resID = await fetch(PROXY_URL, { method: "POST", headers: { "Schema-Id": schemaType }, body: JSON.stringify({ locationId: LOCATION_ID, page: 1, pageLimit: 20 }) });
            const d = await resID.json();
            let max = 0;
            (d.records || []).forEach(r => {
                const p = r.properties || {};
                const idVal = p.equipment_id || p.deployment_id || p.return_id || "";
                const num = parseInt(idVal.replace(/\D/g, ''));
                if (!isNaN(num) && num > max) max = num;
            });
            return res.status(200).json({ nextID: `${prefix}${(max + 1).toString().padStart(7, '0')}` });
        }

        // --- 3. CREATE DEPLOYMENT ---
        if (action === 'createDeployment') {
            const resDep = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA }, body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) });
            const newDep = await resDep.json();
            const newId = newDep.id || newDep.record?.id;
            if (newId) {
                await Promise.all([
                    fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: DEPLOY_TO_GEAR_ASSOC, firstRecordId: newId, secondRecordId: gearID }) }),
                    fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: gearID, secondRecordId: merchantID }) }),
                    fetch(`${PROXY_URL}${gearID}?locationId=${LOCATION_ID}`, { method: "PUT", headers: { "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ properties: { merchant_account: merchantName } }) })
                ]);
                return res.status(200).json({ success: true });
            }
        }

        // --- 4. CREATE EQUIPMENT ---
        if (action === 'createEquipment') {
            const resEq = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) });
            const newEq = await resEq.json();
            const newEqId = newEq.id || newEq.record?.id;
            if (newEqId) {
                await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: newEqId, secondRecordId: merchantID }) });
                return res.status(200).json({ success: true });
            }
        }

        // --- 5. LIST & DELETE ---
        if (action === 'list') {
            const resData = await fetch(PROXY_URL, { method: "POST", headers: { "Schema-Id": req.body.schemaId || EQUIPMENT_SCHEMA, "Content-Type": "application/json" }, body: JSON.stringify({ locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15, query: query }) });
            const d = await resData.json();
            return res.status(200).json({ success: true, ...d });
        }

        if (action === 'delete') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, { method: "DELETE" });
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
