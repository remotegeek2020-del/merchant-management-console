export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const SCHEMA_KEY = "custom_objects.equipments";
    const ASSOC_ID = "6728643af1853631d21b97af";
    
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: "Method Not Allowed" });

    const { action, id, payload, query, view, page, limit } = req.body;

    try {
        // --- FIXED ACTION: LIST ---
        if (action === 'list') {
            const requestParams = { locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15 };

            // Fixed Sorting Logic for Created/Updated
            if (view === "createdAt" || view === "updatedAt") {
                requestParams.sort = [{ field: view, direction: "desc" }];
            } else if (view && view.includes('Warsaw')) {
                requestParams.query = view;
                requestParams.sort = [{ field: "updatedAt", direction: "desc" }];
            }

            if (query && query.trim() !== "") {
                requestParams.query = (requestParams.query ? requestParams.query + " " : "") + query.trim();
            }

            const response = await fetch(PROXY_URL, {
                method: "POST",
                headers: { "Schema-Id": SCHEMA_KEY, "Content-Type": "application/json", "Version": "2021-07-28" },
                body: JSON.stringify(requestParams)
            });

            const data = await response.json();
            return res.status(200).json({ success: true, ...data });
        }

        // --- FIXED ACTION: UPDATE SURGICAL ---
        if (action === 'updateSurgical') {
            const accountIds = {
                "Warsaw Office / Inventory": "6993793b3572dc52847e4fe0",
                "Warsaw Repairs": "6999c33007a6e56e436c0e84"
            };

            // 1. Get current relations to clear old merchant links
            const relRes = await fetch(`${PROXY_URL}relations/${id}?locationId=${LOCATION_ID}&skip=0&limit=10`, {
                headers: { "Schema-Id": SCHEMA_KEY }
            });
            const relData = await relRes.json();

            if (relData.relations) {
                for (const rel of relData.relations) {
                    const isMerchant = rel.firstObjectKey?.includes("merchants") || rel.secondObjectKey?.includes("merchants");
                    if (isMerchant) {
                        await fetch(`${PROXY_URL}relations/${rel.id}?locationId=${LOCATION_ID}`, { 
                            method: "DELETE", headers: { "Schema-Id": SCHEMA_KEY } 
                        });
                    }
                }
            }

            // 2. Update the record properties
            const updateRes = await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json", "Schema-Id": SCHEMA_KEY },
                body: JSON.stringify({ properties: payload })
            });

            if (!updateRes.ok) throw new Error("Failed to update properties in GHL");

            // 3. Re-link to new location if applicable
            const targetMerchantId = accountIds[payload.merchant_account];
            if (targetMerchantId) {
                await fetch(PROXY_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Link-Relation": "true" },
                    body: JSON.stringify({
                        locationId: LOCATION_ID,
                        associationId: ASSOC_ID,
                        firstRecordId: id,
                        secondRecordId: targetMerchantId
                    })
                });
            }
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        console.error("Server API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
