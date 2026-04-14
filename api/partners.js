import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, person_id, id, payload } = body;

    if (!action) return res.status(400).json({ success: false, message: "No action provided" });

    try {

// --- ACTION: GET MERCHANT DATA (Using High-Speed View) ---
if (action === 'get_merchant_data') {
    const { identifier_ids } = body;
    try {
        const { data: stats, error } = await supabase
            .from('merchant_stats_by_id')
            .select('*')
            .in('agent_id', identifier_ids); // identifier_ids must be an array of strings

        if (error) throw error;
        
        // Log this to your server console to see if the DB is returning more than 1
        console.log("Stats returned from DB:", stats);

        return res.status(200).json({ success: true, data: stats });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
        // --- ACTION: MOVE IDENTIFIER (Legacy/Single Update) ---
        if (action === 'move_identifier') {
            const { identifier_id, new_parent_id } = body;

            if (identifier_id === new_parent_id) {
                return res.status(400).json({ success: false, message: "ID cannot be its own parent." });
            }

            const parentId = (!new_parent_id || new_parent_id === "" || new_parent_id === "null") 
                ? null 
                : new_parent_id;

            const { error } = await supabase
                .from('agent_identifiers')
                .update({ parent_config_id: parentId })
                .eq('id', identifier_id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET PARTNERS LIST (Added Email, Phone, and HL ID) ---
        if (action === 'get_partners_list') {
            async function fetchAll(table, select) {
                let allData = [];
                let from = 0;
                let finished = false;
                while (!finished) {
                    const { data, error } = await supabase.from(table).select(select).range(from, from + 999);
                    if (error || !data || data.length === 0) { finished = true; }
                    else {
                        allData = allData.concat(data);
                        from += 1000;
                        if (data.length < 1000) finished = true;
                    }
                }
                return allData;
            }

            const [persons, agents, identifiers, companies] = await Promise.all([
                // UPDATED SELECT STRING BELOW
                fetchAll('persons', 'id, full_name, email, phone_number, hl_contact_id'),
                fetchAll('agents', 'id, company_id, parent_agent_id'),
                fetchAll('agent_identifiers', 'id, agent_id, id_string, rev_share, prime49, parent_config_id'),
                fetchAll('companies', 'id, company_name')
            ]);

            return res.status(200).json({ 
                success: true, 
                data: { persons, agents, identifiers, companies } 
            });
        }

        if (action === 'get_merchant_data_raw') {
    const { identifier_id } = body;
    const { data, error } = await supabase
        .from('merchants')
        .select('merchant_id, dba_name, account_status, volume_30_day')
        .eq('agent_id', identifier_id)
        .eq('account_status', 'Approved'); // Still filtering for Approved

    if (error) return res.status(500).json({ success: false, message: error.message });
    return res.status(200).json({ success: true, data });
}

        // --- ACTION: GET HIERARCHY ---
        if (action === 'get_hierarchy') {
            const { data: masters } = await supabase.from('agents').select('id').eq('parent_agent_id', person_id);
            const masterIds = (masters || []).map(a => a.id);

            const { data: subAgents, error } = await supabase
                .from('agents')
                .select(`agent_name, agent_identifiers (id_string, rev_share)`)
                .in('parent_agent_id', masterIds);

            if (error) throw error;
            return res.status(200).json({ success: true, data: subAgents || [] });
        }

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
