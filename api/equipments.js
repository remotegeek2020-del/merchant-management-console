import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const DEPLOYMENT_SCHEMA = "69a19c2a7134dc2f8d6988ef";
    const RETURN_SCHEMA = "69a314e9fe810d7f8614e1ce";
    const ASSOC_ID = "6728643af1853631d21b97af";
    const RETURN_ASSOC_ID = "69a3151e5767c05d16488ab9";

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, view, page, limit, userEmail, schemaType, prefix } = req.body;

    const logAction = async (msg) => {
        await supabase.from('activity_logs').insert([{
            email: userEmail || 'System', action: msg, status: 'SUCCESS', ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
        }]);
    };

    try {
        // --- ACTION: LIST DEPLOYMENTS (With Hardware Hydration) ---
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

            // Fetch linked hardware for each deployment record found
            const hydratedRecords = await Promise.all((data.records || []).map(async (record) => {
                try {
                    const relRes = await fetch(`${PROXY_URL}relations/${record.id}?locationId=${LOCATION_ID}`);
                    const relData = await relRes.json();
                    const equipmentRel = relData.relations?.find(r => r.secondObjectKey.includes('equipments') || r.firstObjectKey.includes('equipments'));
                    
                    if (equipmentRel) {
                        const eqID = equipmentRel.firstRecordId === record.id ? equipmentRel.secondRecordId : equipmentRel.firstRecordId;
                        const eqRes = await fetch(`${PROXY_URL}${EQUIPMENT_SCHEMA}/records/${eqID}?locationId=${LOCATION_ID}`);
                        const eqData = await eqRes.json();
                        return { ...record, hardware: eqData.record?.properties || eqData.properties || {} };
                    }
                } catch (e) { console.error("Hydration failed", record.id); }
                return { ...record, hardware: {} };
            }));

            return res.status(200).json({ success: true, records: hydratedRecords });
        }

        // --- ACTION: LIST (General Lookups) ---
        if (action === 'list') {
            const schema = req.body.schemaId || EQUIPMENT_SCHEMA;
            const resData = await fetch(PROXY_URL, {
                method: "POST",
                headers: { "Schema-Id": schema, "Content-Type": "application/json", "Version": "2021-07-28" },
                body: JSON.stringify({ locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15, query: query })
            });
            const data = await resData.json();
            return res.status(200).json({ success: true, ...data });
        }

        // --- ACTION: GET NEXT ID ---
        if (action === 'getNextID') {
            const resID = await fetch(PROXY_URL, { method: "POST", headers: { "Schema-Id": schemaType }, body: JSON.stringify({ locationId: LOCATION_ID, page: 1, pageLimit: 20 }) });
            const data = await resID.json();
            let max = 0;
            (data.records || []).forEach(r => {
                const props = r.properties || {};
                const idVal = props.equipment_id || props.deployment_id || props.return_id || r.name || "";
                const num = parseInt(idVal.replace(/\D/g, ''));
                if (!isNaN(num) && num > max) max = num;
            });
            if (max === 0 && prefix === 'Equip-') max = 108039;
            const finalID = `${prefix}${(max + 1).toString().padStart(prefix === 'Equip-' ? 0 : 7, '0')}`;
            return res.status(200).json({ nextID: finalID });
        }

        // --- ACTION: CREATE EQUIPMENT ---
        if (action === 'createEquipment') {
            const resEq = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) });
            const newEq = await resEq.json();
            await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: newEq.id, secondRecordId: req.body.merchantID }) });
            await logAction(`Hardware In-take: ${payload.equipment_id} / SN: ${payload.serial_number}`);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: CREATE DEPLOYMENT ---
        if (action === 'createDeployment') {
            const rels = await fetch(`${PROXY_URL}relations/${req.body.gearID}?locationId=${LOCATION_ID}`).then(r => r.json());
            for (const rel of (rels.relations || [])) await fetch(`${PROXY_URL}relations/${rel.id}?locationId=${LOCATION_ID}`, { method: "DELETE" });
            const resDep = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA }, body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) });
            const newDep = await resDep.json();
            await fetch(PROXY_URL, { method: "POST", headers: { "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: "69a19ca47e855c2e654a44f7", firstRecordId: newDep.id, secondRecordId: req.body.gearID }) });
            await fetch(PROXY_URL, { method: "POST", headers: { "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: req.body.gearID, secondRecordId: req.body.merchantID }) });
            await fetch(`${PROXY_URL}${req.body.gearID}?locationId=${LOCATION_ID}`, { method: "PUT", headers: { "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ properties: { merchant_account: req.body.merchantName } }) });
            await logAction(`Deployment Created: ${payload.deployment_id} linked to ${req.body.merchantName}`);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: CREATE RETURN ---
        if (action === 'createReturn') {
            const resRet = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": RETURN_SCHEMA }, body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) });
            const newRet = await resRet.json();
            await fetch(PROXY_URL, { method: "POST", headers: { "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: RETURN_ASSOC_ID, firstRecordId: req.body.gearID, secondRecordId: newRet.id }) });
            await logAction(`Return Processed: ${payload.return_id}`);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: UPDATE SURGICAL ---
        if (action === 'updateSurgical') {
            // Re-fetch relations to clear old merchant links
            const relRes = await fetch(`${PROXY_URL}relations/${id}?locationId=${LOCATION_ID}`);
            const relData = await relRes.json();
            if (relData.relations) {
                for (const rel of relData.relations) {
                    if (rel.firstObjectKey?.includes("merchants") || rel.secondObjectKey?.includes("merchants")) {
                        await fetch(`${PROXY_URL}relations/${rel.id}?locationId=${LOCATION_ID}`, { method: "DELETE" });
                    }
                }
            }
            // Update properties and log
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, { method: "PUT", headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ properties: payload }) });
            await logAction(`Manual Surgical Edit on Gear ${payload.equipment_id}`);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: DELETE ---
        if (action === 'delete') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, { method: "DELETE", headers: { "Version": "2021-07-28" } });
            await logAction(`Deleted Record ID: ${id}`);
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
