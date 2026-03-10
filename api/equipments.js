import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const DEPLOYMENT_SCHEMA = "69a19c2a7134dc2f8d6988ef";
    const RETURN_SCHEMA = "69a314e9fe810d7f8614e1ce";
    const MERCHANT_SCHEMA = "6713847a517aa62ab429e204"; 
    const ASSOC_ID = "6728643af1853631d21b97af"; 
    const DEPLOY_TO_GEAR_ASSOC = "69a19ca47e855c2e654a44f7"; 
    const RETURN_ASSOC_ID = "69a3151e5767c05d16488ab9"; 

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, userEmail, gearID, merchantID, merchantName, prefix, internalId, query } = req.body;

    // Helper function to insert logs into Supabase
    const logAction = async (msg, status = 'SUCCESS') => {
        try {
            await supabase.from('activity_logs').insert([{
                email: userEmail || 'System', 
                action: msg, 
                status: status, 
                ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
            }]);
        } catch (logErr) {
            console.error("Logging failed:", logErr.message);
        }
    };

    try {
        // --- ACTION: HYDRATE DATA ---
        if (action === 'getHydratedData') {
            const relRes = await fetch(`${PROXY_URL}relations/${internalId}?locationId=${LOCATION_ID}`);
            const relData = await relRes.json();
            
            const rel = (relData.relations || []).find(r => 
                r.secondObjectKey.includes('equipments') || 
                r.firstObjectKey.includes('equipments') ||
                r.secondObjectKey.includes(EQUIPMENT_SCHEMA)
            );

            if (rel) {
                const equipmentId = (rel.firstRecordId === internalId) ? rel.secondRecordId : rel.firstRecordId;
                const eqRes = await fetch(`${PROXY_URL}custom_objects.equipments/records/${equipmentId}?locationId=${LOCATION_ID}`, {
                    headers: { "Schema-Id": EQUIPMENT_SCHEMA }
                });
                const eqData = await eqRes.json();
                return res.status(200).json({ success: true, data: eqData.record?.properties || eqData.properties });
            }
            return res.status(404).json({ success: false, message: "No link found" });
        }

        // --- ACTION: LIST ---
        if (action === 'list') {
            const schema = req.body.schemaId || EQUIPMENT_SCHEMA;
            const resData = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Schema-Id": schema, "Content-Type": "application/json" }, 
                body: JSON.stringify({ locationId: LOCATION_ID, page: req.body.page || 1, pageLimit: 15, query: query }) 
            });
            const data = await resData.json();
            return res.status(200).json({ success: true, records: data.records || [] });
        }

        // --- ACTION: GET NEXT ID ---
        if (action === 'getNextID') {
            let targetSchema = EQUIPMENT_SCHEMA;
            if (prefix === 'DPL-') targetSchema = DEPLOYMENT_SCHEMA;
            if (prefix === 'RTR-') targetSchema = RETURN_SCHEMA;

            const resID = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Schema-Id": targetSchema }, 
                body: JSON.stringify({ locationId: LOCATION_ID, page: 1, pageLimit: 20 }) 
            });
            const d = await resID.json();
            let max = 0;
            (d.records || []).forEach(r => {
                const p = r.properties || {};
                const idVal = p.equipment_id || p.deployment_id || p.return_id || "";
                const num = parseInt(idVal.replace(/\D/g, ''));
                if (!isNaN(num) && num > max) max = num;
            });
            if (max === 0 && prefix === 'Equip-') max = 108039;
            return res.status(200).json({ nextID: `${prefix}${(max + 1).toString().padStart(7, '0')}` });
        }

        // --- ACTION: CREATE EQUIPMENT ---
        if (action === 'createEquipment') {
            const resEq = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, 
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) 
            });
            const d = await resEq.json();
            const nId = d.id || d.record?.id;
            if (nId && merchantID) {
                await fetch(PROXY_URL, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                    body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: nId, secondRecordId: merchantID }) 
                });
            }
            await logAction(`New Equipment Created: ${payload.equipment_id}`);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: CREATE DEPLOYMENT ---
        if (action === 'createDeployment') {
            const resDep = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA }, 
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) 
            });
            const d = await resDep.json();
            const nId = d.id || d.record?.id;
            if (nId) {
                await fetch(PROXY_URL, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                    body: JSON.stringify({ locationId: LOCATION_ID, associationId: DEPLOY_TO_GEAR_ASSOC, firstRecordId: nId, secondRecordId: gearID }) 
                });
                await fetch(PROXY_URL, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                    body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: gearID, secondRecordId: merchantID }) 
                });
                await fetch(`${PROXY_URL}${gearID}?locationId=${LOCATION_ID}`, { 
                    method: "PUT", 
                    headers: { "Schema-Id": EQUIPMENT_SCHEMA }, 
                    body: JSON.stringify({ properties: { merchant_account: merchantName } }) 
                });
                await logAction(`New Deployment Created: ${payload.deployment_id} for ${merchantName}`);
            }
            return res.status(200).json({ success: true });
        }

        // --- ACTION: CREATE RETURN ---
        if (action === 'createReturn') {
            const mappedPayload = {
                "return_id": payload.return_id,
                "return_reason": payload.return_reason,
                "condition": payload.condition,
                "return_status": "open",
                "return_destination": payload.return_destination
            };
            const resRet = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": RETURN_SCHEMA }, 
                body: JSON.stringify({ locationId: LOCATION_ID, properties: mappedPayload }) 
            });
            const newRet = await resRet.json();
            const newRetId = newRet.id || newRet.record?.id;
            if (newRetId) {
                await fetch(PROXY_URL, { 
                    method: "POST", 
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                    body: JSON.stringify({ locationId: LOCATION_ID, associationId: RETURN_ASSOC_ID, firstRecordId: gearID, secondRecordId: newRetId }) 
                });
                await logAction(`Return Processed: ${payload.return_id}`);
            }
            return res.status(200).json({ success: true });
        }

        if (action === 'delete') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, { method: "DELETE" });
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
