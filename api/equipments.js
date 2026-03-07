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
    const { action, id, payload, userEmail, gearID, merchantID, merchantName } = req.body;

    try {
        // --- 1. VERIFIED EQUIPMENT INTAKE (Includes Receive Date Fix) ---
        if (action === 'createEquipment') {
            const resEq = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, 
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) 
            });
            const d = await resEq.json();
            const nId = d.id || d.record?.id;
            
            if (nId) {
                await fetch(PROXY_URL, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                    body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: nId, secondRecordId: merchantID }) 
                });
                return res.status(200).json({ success: true });
            }
        }

        // --- 2. VERIFIED DEPLOYMENT (Clean Relational Swap) ---
        if (action === 'createDeployment') {
            const resDep = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA }, 
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) 
            });
            const d = await resDep.json();
            const nId = d.id || d.record?.id;
            
            if (nId) {
                // Link Deployment to Gear and Gear to Merchant simultaneously
                await Promise.all([
                    fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: DEPLOY_TO_GEAR_ASSOC, firstRecordId: nId, secondRecordId: gearID }) }),
                    fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: gearID, secondRecordId: merchantID }) }),
                    fetch(`${PROXY_URL}${gearID}?locationId=${LOCATION_ID}`, { method: "PUT", headers: { "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ properties: { merchant_account: merchantName } }) })
                ]);
                return res.status(200).json({ success: true });
            }
        }

        // --- 3. VERIFIED RETURNS (Matches Postman Keys) ---
        if (action === 'createReturn') {
            const resRet = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": RETURN_SCHEMA }, 
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) 
            });
            const d = await resRet.json();
            const nId = d.id || d.record?.id;
            
            if (nId) {
                await fetch(PROXY_URL, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                    body: JSON.stringify({ locationId: LOCATION_ID, associationId: RETURN_ASSOC_ID, firstRecordId: gearID, secondRecordId: nId }) 
                });
                return res.status(200).json({ success: true });
            }
        }

        // --- 4. DASHBOARD UPDATES (Fixes "Stuck" Status) ---
        if (action === 'updateSurgical' || action === 'updateDeployment') {
            const schema = action === 'updateSurgical' ? EQUIPMENT_SCHEMA : DEPLOYMENT_SCHEMA;
            const resUpd = await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, { 
                method: "PUT", 
                headers: { "Content-Type": "application/json", "Schema-Id": schema }, 
                body: JSON.stringify({ properties: payload }) 
            });
            if (resUpd.ok) return res.status(200).json({ success: true });
        }

        // --- 5. DASHBOARD LISTING & DELETE ---
        if (action === 'list') {
            const resData = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Schema-Id": req.body.schemaId || EQUIPMENT_SCHEMA, "Content-Type": "application/json" }, 
                body: JSON.stringify({ locationId: LOCATION_ID, page: req.body.page || 1, pageLimit: 15, query: req.body.query }) 
            });
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
