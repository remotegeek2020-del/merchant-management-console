import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const body = req.body || {};
    const { action, person_id, id, payload } = body;

    if (!action) return res.status(400).json({ success: false, message: "No action provided" });

    try {

        if (action === 'update_person_field') {
    const { id, field, value } = body;
    const { error } = await supabase
        .from('persons')
        .update({ [field]: value })
        .eq('id', id);
    return res.status(200).json({ success: !error });
}

   // Example of what your backend logic should look like:
if (action === 'get_orphan_ids') {
    const { query, placeholder_uuid } = body;
    const { data, error } = await supabase
        .from('agent_identifiers')
        .select('id_string')
        .eq('agent_id', placeholder_uuid) // Filter for the "Placeholder Agent"
        .ilike('id_string', `%${query}%`)  // Search the string
        .limit(10);
    return res.status(200).json({ data });
}
        if (action === 'search_ghl') {
    const { query } = body;
    const ghlRes = await fetch(`https://services.leadconnectorhq.com/contacts/?locationId=dfg08aPdtlQ1RhIKkCnN&query=${query}`, {
        headers: {
            'Authorization': 'Bearer pit-4da3c37b-fcae-4274-a893-7ad7777a4bba',
            'Version': '2021-07-28'
        }
    });
    const data = await ghlRes.json();
    return res.status(200).json({ success: true, contacts: data.contacts });
}
if (action === 'complete_onboarding') {
    const { person, company, identifiers, isQuickAdd, existingAgentId } = body;
    let finalAgentId = existingAgentId;

    if (!isQuickAdd) {
        // --- START NEW PARTNER LOGIC ---
        // Verify we have person data
        if (!person || !person.email) return res.status(400).json({ success: false, message: "Missing person data for new partner" });

        const properName = person.name.toLowerCase().split(' ').map(s => s.charAt(0).toUpperCase() + s.substring(1)).join(' ');

        // 1. Upsert Person
        const { data: pData, error: pErr } = await supabase
            .from('persons')
            .upsert({ 
                full_name: properName, 
                email: person.email, 
                phone_number: person.phone, 
                hl_contact_id: person.hl_id 
            }, { onConflict: 'email' })
            .select().single();

        if (pErr) return res.status(400).json({ success: false, message: "Person failed: " + pErr.message });

        // 2. Handle Company
        let targetCoId = company.id;
        if (!targetCoId && !company.isIndependent && company.name) {
            const { data: coData } = await supabase.from('companies').insert({ company_name: company.name }).select().single();
            targetCoId = coData ? coData.id : null;
        }

        // 3. Create Agent
        const { data: agentData, error: agentErr } = await supabase.from('agents').insert({
            company_id: targetCoId,
            agent_name: properName,
            parent_agent_id: pData.id
        }).select().single();

        if (agentErr) return res.status(400).json({ success: false, message: "Agent creation failed: " + agentErr.message });
        finalAgentId = agentData.id;
        // --- END NEW PARTNER LOGIC ---
    }

    // Link IDs (This runs for both modes)
    const idInserts = identifiers.map(id => ({
        agent_id: finalAgentId,
        id_string: id.string,
        rev_share: id.rev,
        prime49: id.prime,
        status: 'active'
    }));

    const { error: finalErr } = await supabase.from('agent_identifiers').upsert(idInserts, { onConflict: 'id_string' });

    return res.status(200).json({ success: !finalErr, message: finalErr?.message });
}
        // --- ACTION: SEARCH BY MID ---
if (action === 'search_by_mid') {
    const { mid } = body;
    const { data, error } = await supabase
        .from('merchants')
        .select('agent_id')
        .eq('merchant_id', mid)
        .limit(1);

    if (error) return res.status(500).json({ success: false });
    return res.status(200).json({ success: true, agent_id: data[0]?.agent_id });
}

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
        if (action === 'update_identifier_all') {
    const { id, rev_share, prime49, new_parent_id } = body;
    const { error } = await supabase
        .from('agent_identifiers')
        .update({ 
            rev_share, 
            prime49, 
            parent_config_id: new_parent_id 
        })
        .eq('id', id);
    return res.status(200).json({ success: !error, message: error?.message });
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

 // Inside partners.js
if (action === 'get_merchant_data_raw') {
    const { identifier_id } = body;
    const { data, error } = await supabase
        .from('merchants')
        .select('dba_name, account_status, volume_30_day, volume_90_day') // <-- Ensure volume_90_day is here!
        .eq('agent_id', identifier_id);
    
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
