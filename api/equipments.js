import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const DEPLOYMENT_SCHEMA = "69a19c2a7134dc2f8d6988ef";
    const ASSOC_ID = "6728643af1853631d21b97af"; 
    const DEPLOY_TO_GEAR_ASSOC = "69a19ca47e855c2e654a44f7"; 

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, view, page, limit, userEmail, gearID, merchantID, merchantName } = req.body;

    const logAction = async (msg) => {
        await supabase.from('activity_logs').insert([{
            email: userEmail || 'System', action: msg, status: 'SUCCESS', ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
        }]);
    };

    try {
        // --- ACTION: LIST DEPLOYMENTS (DEEP SCAN HYDRATION) ---
        if (action === 'listDeployments') {
            const response = await fetch(PROXY_URL, {
                method: "POST",
                headers: { "Schema-Id": DEPLOYMENT_SCHEMA, "Content-Type": "application/json", "Version": "2021-07-28" },
                body: JSON.stringify({ 
                    locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15, query: query,
                    sort: [{ field: view || "createdAt", direction: "desc" }] 
                })
            });
            const data = await response.json();

            const hydratedRecords = await Promise.all((data.records || []).map(async (record) => {
                try {
                    // 1. Fetch ALL relations for this deployment record
                    const relRes = await fetch(`${PROXY_URL}relations/${record.id}?locationId=${LOCATION_ID}`);
                    const relData = await relRes.json();
                    
                    // 2. Scan every relation for a connection to the equipment schema
                    const gearRel = (relData.relations || []).find(r => 
                        r.firstObjectKey?.includes(EQUIPMENT_SCHEMA) || 
                        r.secondObjectKey?.includes(EQUIPMENT_SCHEMA) ||
                        r.firstObjectKey?.includes("equipments") ||
                        r.secondObjectKey?.includes("equipments")
                    );
                    
                    if (gearRel) {
                        const targetID = (gearRel.firstRecordId === record.id) ? gearRel.secondRecordId : gearRel.firstRecordId;
                        const eqRes = await fetch(`${PROXY_URL}${EQUIPMENT_SCHEMA}/records/${targetID}?locationId=${LOCATION_ID}`);
                        const eqData = await eqRes.json();
                        return { ...record, hardware: eqData.record?.properties || eqData.properties || {} };
                    }
                } catch (e) { console.error("Hydration skip", record.id); }
                return { ...record, hardware: {} };
            }));

            return res.status(200).json({ success: true, records: hydratedRecords });
        }

        // --- ACTION: CREATE DEPLOYMENT (RELIABLE SEQUENCE) ---
        if (action === 'createDeployment') {
            const resDep = await fetch(PROXY_URL, {
                method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA },
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload })
            });
            const newDep = await resDep.json();
            const newId = newDep.id || newDep.record?.id;

            if (newId) {
                // Perform links and updates in parallel
                await Promise.all([
                    fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: DEPLOY_TO_GEAR_ASSOC, firstRecordId: newId, secondRecordId: gearID }) }),
                    fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: gearID, secondRecordId: merchantID }) }),
                    fetch(`${PROXY_URL}${gearID}?locationId=${LOCATION_ID}`, { method: "PUT", headers: { "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ properties: { merchant_account: merchantName } }) })
                ]);
                await logAction(`Deployed: ${payload.deployment_id}`);
                return res.status(200).json({ success: true });
            }
            return res.status(400).json({ success: false, message: "Record creation failed" });
        }

        // --- ACTION: UPDATE DEPLOYMENT ---
        if (action === 'updateDeployment') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA },
                body: JSON.stringify({ properties: payload })
            });
            await logAction(`Updated Deployment: ${id}`);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET NEXT ID ---
        if (action === 'getNextID') {
            const resID = await fetch(PROXY_URL, { method: "POST", headers: { "Schema-Id": req.body.schemaType }, body: JSON.stringify({ locationId: LOCATION_ID, page: 1, pageLimit: 20 }) });
            const d = await resID.json();
            let max = 0;
            (d.records || []).forEach(r => {
                const p = r.properties || {};
                const idVal = p.equipment_id || p.deployment_id || p.return_id || "";
                const num = parseInt(idVal.replace(/\D/g, ''));
                if (!isNaN(num) && num > max) max = num;
            });
            if (max === 0 && req.body.prefix === 'Equip-') max = 108039;
            return res.status(200).json({ nextID: `${req.body.prefix}${(max + 1).toString().padStart(7, '0')}` });
        }

        // --- ACTION: LIST GENERAL ---
        if (action === 'list') {
            const sId = req.body.schemaId || EQUIPMENT_SCHEMA;
            const res = await fetch(PROXY_URL, { method: "POST", headers: { "Schema-Id": sId, "Content-Type": "application/json" }, body: JSON.stringify({ locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15, query: query }) });
            const d = await res.json();
            return res.status(200).json({ success: true, ...d });
        }

        // --- ACTION: DELETE ---
        if (action === 'delete') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, { method: "DELETE" });
            await logAction(`Deleted Record: ${id}`);
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
