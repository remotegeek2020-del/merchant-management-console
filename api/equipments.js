import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const DEPLOYMENT_SCHEMA = "69a19c2a7134dc2f8d6988ef";
    const RETURN_SCHEMA = "69a314e9fe810d7f8614e1ce";
    const ASSOC_ID = "6728643af1853631d21b97af"; // Gear to Merchant
    const DEPLOY_TO_GEAR_ASSOC = "69a19ca47e855c2e654a44f7"; // Deployment to Gear
    const RETURN_ASSOC_ID = "69a3151e5767c05d16488ab9";

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, view, page, limit, userEmail, schemaType, prefix, gearID, merchantID, merchantName } = req.body;

    const logAction = async (msg) => {
        await supabase.from('activity_logs').insert([{
            email: userEmail || 'System', action: msg, status: 'SUCCESS', ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
        }]);
    };

    try {
        // --- ACTION: CREATE DEPLOYMENT (Fixed Linking Sequence) ---
        if (action === 'createDeployment') {
            // 1. Clear old relations from hardware first
            const rels = await fetch(`${PROXY_URL}relations/${gearID}?locationId=${LOCATION_ID}`).then(r => r.json());
            for (const rel of (rels.relations || [])) {
                await fetch(`${PROXY_URL}relations/${rel.id}?locationId=${LOCATION_ID}`, { method: "DELETE" });
            }

            // 2. Create Deployment Record
            const resDep = await fetch(PROXY_URL, {
                method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA },
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload })
            });
            const newDep = await resDep.json();
            const newDeployId = newDep.id || newDep.record?.id;

            if (!newDeployId) throw new Error("Deployment record creation failed");

            // 3. SECURE LINKING: Link Deployment to Hardware
            await fetch(PROXY_URL, { 
                method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                body: JSON.stringify({ locationId: LOCATION_ID, associationId: DEPLOY_TO_GEAR_ASSOC, firstRecordId: newDeployId, secondRecordId: gearID }) 
            });

            // 4. SECURE LINKING: Link Hardware to Merchant
            await fetch(PROXY_URL, { 
                method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, 
                body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: gearID, secondRecordId: merchantID }) 
            });

            // 5. Sync hardware properties
            await fetch(`${PROXY_URL}${gearID}?locationId=${LOCATION_ID}`, { 
                method: "PUT", headers: { "Schema-Id": EQUIPMENT_SCHEMA }, 
                body: JSON.stringify({ properties: { merchant_account: merchantName } }) 
            });

            await logAction(`Deployment Created: ${payload.deployment_id} linked to Gear ${gearID}`);
            return res.status(200).json({ success: true, id: newDeployId });
        }

        // --- ACTION: LIST DEPLOYMENTS (Hydration Engine) ---
        if (action === 'listDeployments') {
            const response = await fetch(PROXY_URL, {
                method: "POST", headers: { "Schema-Id": DEPLOYMENT_SCHEMA, "Content-Type": "application/json", "Version": "2021-07-28" },
                body: JSON.stringify({ locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15, query: query, sort: [{ field: view || "createdAt", direction: "desc" }] })
            });
            const data = await response.json();

            const hydratedRecords = await Promise.all((data.records || []).map(async (record) => {
                try {
                    const relRes = await fetch(`${PROXY_URL}relations/${record.id}?locationId=${LOCATION_ID}`, { headers: { "Schema-Id": DEPLOYMENT_SCHEMA } });
                    const relData = await relRes.json();
                    const equipmentRel = (relData.relations || []).find(r => r.firstObjectKey.includes(EQUIPMENT_SCHEMA) || r.secondObjectKey.includes(EQUIPMENT_SCHEMA) || r.firstObjectKey.includes("equipments") || r.secondObjectKey.includes("equipments"));
                    
                    if (equipmentRel) {
                        const eqID = (equipmentRel.firstRecordId === record.id) ? equipmentRel.secondRecordId : equipmentRel.firstRecordId;
                        const eqRes = await fetch(`${PROXY_URL}${EQUIPMENT_SCHEMA}/records/${eqID}?locationId=${LOCATION_ID}`, { headers: { "Schema-Id": EQUIPMENT_SCHEMA } });
                        const eqData = await eqRes.json();
                        return { ...record, hardware: eqData.record?.properties || eqData.properties || {} };
                    }
                } catch (e) { console.error("Hydrate fail", record.id); }
                return { ...record, hardware: null };
            }));
            return res.status(200).json({ success: true, records: hydratedRecords });
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
            return res.status(200).json({ nextID: `${prefix}${(max + 1).toString().padStart(prefix === 'Equip-' ? 0 : 7, '0')}` });
        }

        // --- REMAINING ACTIONS (List, CreateEquipment, CreateReturn, Update, Delete) ---
        if (action === 'list') {
            const schema = req.body.schemaId || EQUIPMENT_SCHEMA;
            const resData = await fetch(PROXY_URL, { method: "POST", headers: { "Schema-Id": schema, "Content-Type": "application/json" }, body: JSON.stringify({ locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15, query: query }) });
            const data = await resData.json();
            return res.status(200).json({ success: true, ...data });
        }

        if (action === 'createEquipment') {
            const resEq = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) });
            const newEq = await resEq.json();
            await fetch(PROXY_URL, { method: "POST", headers: { "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: newEq.id, secondRecordId: req.body.merchantID }) });
            await logAction(`In-take: ${payload.equipment_id}`);
            return res.status(200).json({ success: true });
        }

        if (action === 'createReturn') {
            const resRet = await fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": RETURN_SCHEMA }, body: JSON.stringify({ locationId: LOCATION_ID, properties: payload }) });
            const newRet = await resRet.json();
            await fetch(PROXY_URL, { method: "POST", headers: { "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: RETURN_ASSOC_ID, firstRecordId: gearID, secondRecordId: newRet.id || newRet.record?.id }) });
            await logAction(`Return: ${payload.return_id}`);
            return res.status(200).json({ success: true });
        }

        if (action === 'updateSurgical') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, { method: "PUT", headers: { "Content-Type": "application/json", "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ properties: payload }) });
            await logAction(`Manual Update: ${id}`);
            return res.status(200).json({ success: true });
        }

        if (action === 'delete') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, { method: "DELETE" });
            await logAction(`Deleted: ${id}`);
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
