import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";
    const DEPLOYMENT_SCHEMA = "69a19c2a7134dc2f8d6988ef";
    const ASSOC_ID = "6728643af1853631d21b97af"; 
    const DEPLOY_TO_GEAR_ASSOC = "69a19ca47e855c2e654a44f7"; 

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, view, page, limit, userEmail, schemaType, prefix, gearID, merchantID, merchantName } = req.body;

    const logAction = async (msg, status = 'SUCCESS') => {
        await supabase.from('activity_logs').insert([{
            email: userEmail || 'System', action: msg, status: status, ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
        }]);
    };

    try {
        // --- ACTION: LIST DEPLOYMENTS (Fast Hydration) ---
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

            // We use Promise.allSettled to ensure one slow link doesn't crash the whole dashboard
            const hydratedRecords = await Promise.all((data.records || []).map(async (record) => {
                try {
                    const relRes = await fetch(`${PROXY_URL}relations/${record.id}?locationId=${LOCATION_ID}`, {
                        headers: { "Schema-Id": DEPLOYMENT_SCHEMA }
                    });
                    const relData = await relRes.json();
                    
                    const equipmentRel = (relData.relations || []).find(r => 
                        r.firstObjectKey.includes(EQUIPMENT_SCHEMA) || 
                        r.secondObjectKey.includes(EQUIPMENT_SCHEMA) ||
                        r.firstObjectKey.includes("equipments")
                    );
                    
                    if (equipmentRel) {
                        const eqID = (equipmentRel.firstRecordId === record.id) ? equipmentRel.secondRecordId : equipmentRel.firstRecordId;
                        const eqRes = await fetch(`${PROXY_URL}${EQUIPMENT_SCHEMA}/records/${eqID}?locationId=${LOCATION_ID}`, {
                            headers: { "Schema-Id": EQUIPMENT_SCHEMA }
                        });
                        const eqData = await eqRes.json();
                        return { ...record, hardware: eqData.record?.properties || eqData.properties || {} };
                    }
                } catch (e) { console.error("Hydration skip for", record.id); }
                return { ...record, hardware: {} }; // Return empty hardware if link fails
            }));

            return res.status(200).json({ success: true, records: hydratedRecords });
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

        // ... (Keep existing CREATE and GET_NEXT_ID actions)
        
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
