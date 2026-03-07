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
        // --- 1. CREATE RETURN (Redesigned for Stability) ---
        if (action === 'createReturn') {
            if (!gearID) throw new Error("Hardware reference (gearID) is missing from the request.");

            const resRet = await fetch(PROXY_URL, { 
                method: "POST", 
                headers: { "Content-Type": "application/json", "Schema-Id": RETURN_SCHEMA }, 
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) 
            });
            const newRet = await resRet.json();
            const newRetId = newRet.id || newRet.record?.id;

            if (newRetId) {
                // We use a separate try/catch for linking so a link failure doesn't crash the save
                try {
                    await fetch(PROXY_URL, { 
                        method: "POST", 
                        headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                        body: JSON.stringify({ 
                            locationId: LOCATION_ID, associationId: RETURN_ASSOC_ID, 
                            firstRecordId: gearID, secondRecordId: newRetId 
                        }) 
                    });
                } catch (e) { console.error("Relationship Link Failed:", e.message); }
                
                await logAction(`Return Logged: ${payload.return_id}`);
                return res.status(200).json({ success: true }); // Success signal to close the form
            }
            throw new Error("GoHighLevel rejected the Return record.");
        }

        // --- 2. UPDATE DEPLOYMENT ---
        if (action === 'updateDeployment') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, {
                method: "PUT", headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA },
                body: JSON.stringify({ properties: payload })
            });
            await logAction(`Deployment Update: ${id}`);
            return res.status(200).json({ success: true });
        }

        // --- 3. UPDATE SURGICAL ---
        if (action === 'updateSurgical') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, {
                method: "PUT", headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA },
                body: JSON.stringify({ properties: payload })
            });
            await logAction(`Inventory Edit: ${payload.equipment_id || id}`);
            return res.status(200).json({ success: true });
        }

        // --- 4. LIST (Standard Search) ---
        if (action === 'list') {
            const schema = req.body.schemaId || EQUIPMENT_SCHEMA;
            const resData = await fetch(PROXY_URL, {
                method: "POST", headers: { "Schema-Id": schema, "Content-Type": "application/json", "Version": "2021-07-28" },
                body: JSON.stringify({ locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15, query: query })
            });
            const data = await resData.json();
            return res.status(200).json({ success: true, ...data });
        }

        // --- 5. CREATE DEPLOYMENT ---
        if (action === 'createDeployment') {
            const resDep = await fetch(PROXY_URL, {
                method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA },
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload })
            });
            const newDep = await resDep.json();
            const newId = newDep.id || newDep.record?.id;
            if (newId) {
                await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: DEPLOY_TO_GEAR_ASSOC, firstRecordId: newId, secondRecordId: gearID }) });
                await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: gearID, secondRecordId: merchantID }) });
                await fetch(`${PROXY_URL}${gearID}?locationId=${LOCATION_ID}`, { method: "PUT", headers: { "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ properties: { merchant_account: merchantName } }) });
                await logAction(`Gear Deployed: ${payload.deployment_id}`);
                return res.status(200).json({ success: true });
            }
        }

        // --- 6. CREATE EQUIPMENT ---
        if (action === 'createEquipment') {
            const resEq = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) });
            const newEq = await resEq.json();
            const newEqId = newEq.id || newEq.record?.id;
            if (newEqId) {
                await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: newEqId, secondRecordId: merchantID }) });
                await logAction(`Inventory In-take: ${payload.equipment_id}`);
                return res.status(200).json({ success: true });
            }
        }

        // --- 7. GET NEXT ID ---
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

        // --- 8. DELETE ---
        if (action === 'delete') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, { method: "DELETE" });
            await logAction(`Deleted Record: ${id}`);
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
