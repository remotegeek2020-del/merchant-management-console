import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
    const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";
    const EQUIPMENT_SCHEMA = "6717da1c4a74233fa104889f";

    const { action, query, view, page, limit, id } = req.body;

    try {
        let fetchUrl = PROXY_URL;
        let options = {
            headers: { 
                "Schema-Id": EQUIPMENT_SCHEMA, 
                "Content-Type": "application/json",
                "Version": "2021-07-28"
            }
        };

        if (req.method === 'POST') {
            options.method = "POST";
            
            // Build the complex query parameters for GHL
            const requestParams = { locationId: LOCATION_ID, page: page || 1, pageLimit: limit || 15 };

            // Handle View Filters (Warsaw Office, Repairs, etc)
            if (view === "Warsaw Office / Inventory" || view === "Warsaw Repairs") {
                requestParams.query = view;
                requestParams.sort = [{ field: "updatedAt", direction: "desc" }];
            } else if (view && view !== 'all') {
                requestParams.sort = [{ field: view, direction: "desc" }];
            }

            // Handle Search String
            if (query && query.trim() !== "") {
                requestParams.query = (requestParams.query ? requestParams.query + " " : "") + query.trim();
            }

            options.body = JSON.stringify(requestParams);
        } else if (req.method === 'DELETE') {
            options.method = "DELETE";
            fetchUrl = `${PROXY_URL}${id}?locationId=${LOCATION_ID}`;
        }

        const ghlRes = await fetch(fetchUrl, options);
        const data = await ghlRes.json();
        return res.status(200).json(data);

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
