import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const DEPLOYMENT_SCHEMA = "69a19c2a7134dc2f8d6988ef";
    const RETURN_SCHEMA = "69a314e9fe810d7f8614e1ce";
    const ASSOC_ID = "6728643af1853631d21b97af"; // Equipment to Merchant
    const DEPLOY_TO_GEAR_ASSOC = "69a19ca47e855c2e654a44f7"; // Deployment to Equipment
    const RETURN_ASSOC_ID = "69a3151e5767c05d16488ab9";

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, view, page, limit, userEmail, schemaType, prefix, gearID, merchantID, merchantName } = req.body;

    const logAction = async (msg, status = 'SUCCESS') => {
        await supabase.from('activity_logs').insert([{
            email: userEmail || 'System', action: msg, status: status, ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
        }]);
    };

    try {
        // --- ACTION: LIST DEPLOYMENTS (Brute Force Hydration) ---
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
                    // 1. Fetch ALL relations for this specific record
                    const relRes = await fetch(`${PROXY_URL}relations/${record.id}?locationId=${LOCATION_ID}`);
                    const relData = await relRes.json();
                    
                    // 2. Find the link that isn't the current record
                    const otherRecord = (relData.relations || []).find(r => 
                        (r.firstRecordId !== record.id) || (r.secondRecordId !== record.id)
                    );
                    
                    if (otherRecord) {
                        const targetID = (otherRecord.firstRecordId === record.id) ? otherRecord.secondRecordId : otherRecord.firstRecordId;
                        
                        // 3. Attempt to fetch the linked hardware details
                        const eqRes = await fetch(`${PROXY_URL}${EQUIPMENT_SCHEMA}/records/${targetID}?locationId=${LOCATION_ID}`);
                        const eqData = await eqRes.json();
                        const props = eqData.record?.properties || eqData.properties;
                        
                        if (props && props.equipment_id) {
                            return { ...record, hardware: props };
                        }
                    }
                } catch (e) { console.error("Link search failed for", record.id); }
                return { ...record, hardware: {} };
            }));

            return res.status(200).json({ success: true, records: hydratedRecords });
        }

        // --- ACTION: CREATE DEPLOYMENT (Reliable Linking) ---
        if (action === 'createDeployment') {
            // Step 1: Create the Deployment record
            const resDep = await fetch(PROXY_URL, {
                method: "POST", headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA },
                body: JSON.stringify({ locationId: LOCATION_ID, properties: payload })
            });
            const newDep = await resDep.json();
            const newId = newDep.id || newDep.record?.id;

            if (newId) {
                // Step 2: Establish links in parallel to prevent bottlenecks
                await Promise.all([
                    // Link Deployment -> Physical Gear
                    fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: DEPLOY_TO_GEAR_ASSOC, firstRecordId: newId, secondRecordId: gearID }) }),
                    // Link Physical Gear -> Merchant
                    fetch(PROXY_URL, { method: "POST", headers: { "Content-Type": "application/json", "Link-Relation": "true" }, body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: gearID, secondRecordId: merchantID }) }),
                    // Update Hardware text field for dashboard filtering
                    fetch(`${PROXY_URL}${gearID}?locationId=${LOCATION_ID}`, { method: "PUT", headers: { "Schema-Id": EQUIPMENT_SCHEMA }, body: JSON.stringify({ properties: { merchant_account: merchantName } }) })
                ]);
                
                await logAction(`Deployed Record ${payload.deployment_id} to ${merchantName}`);
                return res.status(200).json({ success: true });
            }
            throw new Error("Failed to create deployment record");
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
            return res.status(200).json({ nextID: `${prefix}${(max + 1).toString().padStart(7, '0')}` });
        }

        // --- ACTION: UPDATE DEPLOYMENT ---
        if (action === 'updateDeployment') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", "Schema-Id": DEPLOYMENT_SCHEMA },
                body: JSON.stringify({ properties: payload })
            });
            await logAction(`Updated Deployment ${id}`);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: LIST GENERAL (Search/Lookups) ---
        if (action === 'list') {
            const sId = req.body.schemaId || EQUIPMENT_SCHEMA;
            const resData = await fetch(PROXY_URL, { method: "POST", headers: { "Schema-Id": sId, "Content-Type": "application/json" }, body: JSON.stringify({ locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15, query: query }) });
            const data = await resData.json();
            return res.status(200).json({ success: true, ...data });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
