import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const SCHEMA_KEY = "custom_objects.equipments";
    const ASSOC_ID = "6728643af1853631d21b97af";

    // Initialize Supabase to write logs
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: "Method Not Allowed" });

    const { action, id, payload, query, view, page, limit, userEmail } = req.body;

    // Helper function to insert into your activity_logs table
    const logAction = async (msg, status = 'SUCCESS') => {
        await supabase.from('activity_logs').insert([{
            email: userEmail || 'System',
            action: msg,
            status: status,
            ip_address: req.headers['x-forwarded-for'] || '127.0.0.1'
        }]);
    };

    try {
        if (action === 'list') {
            const requestParams = { locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15 };
            if (view === "createdAt" || view === "updatedAt") {
                requestParams.sort = [{ field: view, direction: "desc" }];
            } else if (view && view.includes('Warsaw')) {
                requestParams.query = view;
            }
            if (query) requestParams.query = (requestParams.query ? requestParams.query + " " : "") + query.trim();

            const response = await fetch(PROXY_URL, {
                method: "POST",
                headers: { "Schema-Id": SCHEMA_KEY, "Content-Type": "application/json", "Version": "2021-07-28" },
                body: JSON.stringify(requestParams)
            });
            const data = await response.json();
            return res.status(200).json({ success: true, ...data });
        }

        if (action === 'updateSurgical') {
            const accountIds = {
                "Warsaw Office / Inventory": "6993793b3572dc52847e4fe0",
                "Warsaw Repairs": "6999c33007a6e56e436c0e84"
            };

            // 1. Clear old relations
            const relRes = await fetch(`${PROXY_URL}relations/${id}?locationId=${LOCATION_ID}`, {
                headers: { "Schema-Id": SCHEMA_KEY }
            });
            const relData = await relRes.json();
            if (relData.relations) {
                for (const rel of relData.relations) {
                    if (rel.firstObjectKey?.includes("merchants") || rel.secondObjectKey?.includes("merchants")) {
                        await fetch(`${PROXY_URL}relations/${rel.id}?locationId=${LOCATION_ID}`, { 
                            method: "DELETE", headers: { "Schema-Id": SCHEMA_KEY } 
                        });
                    }
                }
            }

            // 2. Update properties
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", "Schema-Id": SCHEMA_KEY },
                body: JSON.stringify({ properties: payload })
            });

            // 3. Re-link
            const targetMerchantId = accountIds[payload.merchant_account];
            if (targetMerchantId) {
                await fetch(PROXY_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" },
                    body: JSON.stringify({ locationId: LOCATION_ID, associationId: ASSOC_ID, firstRecordId: id, secondRecordId: targetMerchantId })
                });
            }

            // LOG THE CHANGE
            await logAction(`Updated Equipment ${payload.equipment_id} -> Moved to ${payload.merchant_account}`);
            
            return res.status(200).json({ success: true });
        }

        if (action === 'delete') {
            await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, {
                method: "DELETE",
                headers: { "Schema-Id": SCHEMA_KEY, "Version": "2021-07-28" }
            });

            // LOG THE DELETION
            await logAction(`Deleted Equipment Record ID: ${id}`);
            
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        await logAction(`Error: ${err.message}`, 'FAILURE');
        return res.status(500).json({ success: false, message: err.message });
    }
}
