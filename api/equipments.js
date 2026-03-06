// api/equipments.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  // Keep these IDs on the server only!
  const PROXY_URL = "https://ghl-merchants-proxy.nmanahan.workers.dev/";
  const SCHEMA_ID = "6717da1c4a74233fa104889f";
  const LOCATION_ID = "dfg08aPdtlQ1RhIKkCnN";

  const { action, id, page, limit, view, query } = req.body;

  try {
    let fetchUrl = PROXY_URL;
    let fetchOptions = {
      headers: {
        "Schema-Id": SCHEMA_ID,
        "Content-Type": "application/json",
        "Version": "2021-07-28"
      }
    };

    if (action === 'list') {
      fetchOptions.method = "POST";
      const params = { locationId: LOCATION_ID, page, pageLimit: limit };
      
      if (view && view !== 'all') {
        if (view.includes('Warsaw')) params.query = view;
        else params.sort = [{ field: view, direction: "desc" }];
      }
      
      if (query) {
        params.query = (params.query ? params.query + " " : "") + query.trim();
      }
      
      fetchOptions.body = JSON.stringify(params);
    } 
    else if (action === 'delete') {
      fetchOptions.method = "DELETE";
      fetchUrl = `${PROXY_URL}${id}?locationId=${LOCATION_ID}`;
    }

    const response = await fetch(fetchUrl, fetchOptions);
    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}