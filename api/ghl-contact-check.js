import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Public endpoint — no session required.
// Called by the GHL custom JS snippet to check if a contact is a portal partner
// before showing the "View in Portal" button.
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ exists: false });

    const { hl_id } = req.query;
    if (!hl_id || typeof hl_id !== 'string' || hl_id.length > 64) {
        return res.status(400).json({ exists: false });
    }

    const { data } = await supabase
        .from('persons')
        .select('id')
        .eq('hl_contact_id', hl_id)
        .maybeSingle();

    return res.status(200).json({ exists: !!data });
}
