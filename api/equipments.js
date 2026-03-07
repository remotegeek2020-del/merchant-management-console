// Add this to your existing api/equipments.js on GitHub
if (action === 'updateSurgical') {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const SCHEMA_KEY = "custom_objects.equipments";
    const ASSOC_ID = "6728643af1853631d21b97af";
    const accountIds = {
        "Warsaw Office / Inventory": "6993793b3572dc52847e4fe0",
        "Warsaw Repairs": "6999c33007a6e56e436c0e84"
    };

    // 1. Fetch Relations
    const relRes = await fetch(`${PROXY_URL}relations/${id}?locationId=${LOCATION_ID}&skip=0&limit=10`, {
        headers: { "Schema-Id": SCHEMA_KEY }
    });
    const relData = await relRes.json();

    // 2. Delete existing Merchant Relations
    if (relData.relations) {
        for (const rel of relData.relations) {
            const isMerchant = rel.firstObjectKey.includes("merchants") || rel.secondObjectKey.includes("merchants");
            if (isMerchant) {
                await fetch(`${PROXY_URL}relations/${rel.id}?locationId=${LOCATION_ID}`, { 
                    method: "DELETE", headers: { "Schema-Id": SCHEMA_KEY } 
                });
            }
        }
    }

    // 3. Update Equipment Properties
    await fetch(`${PROXY_URL}${id}?locationId=${LOCATION_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Schema-Id": SCHEMA_KEY },
        body: JSON.stringify({ properties: payload })
    });

    // 4. Create New Relation
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
