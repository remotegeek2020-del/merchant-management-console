import { createClient } from '@supabase/supabase-js';

export const config = { 
    api: { bodyParser: { sizeLimit: '10mb' } },
    maxDuration: 30  // 30 second timeout for Vercel Pro, 10s for hobby
};

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
        const enrolledBy = body.enrolled_by || null;
        const { data: pData, error: pErr } = await supabase
            .from('persons')
            .upsert({ 
                full_name: properName, 
                email: person.email, 
                phone_number: person.phone, 
                hl_contact_id: person.hl_id,
                enrolled_at: person.enrolled_at || new Date().toISOString(),
                enrolled_by: enrolledBy
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
    // Resolve parent_config_id from string to UUID if set
    // First build a lookup of id_string -> uuid for already-existing IDs
    const { data: existingIds } = await supabase
        .from('agent_identifiers')
        .select('id, id_string')
        .in('id_string', identifiers.filter(i => i.parent_config_id).map(i => i.parent_config_id));
    
    const parentLookup = {};
    (existingIds || []).forEach(e => { parentLookup[e.id_string] = e.id; });
    // Also check newly added IDs in this batch (pending IDs that are parents of others)
    const pendingParentMap = {};
    identifiers.forEach(id => { pendingParentMap[id.string] = null; }); // will be filled after upsert

    const idInserts = identifiers.map(id => ({
        agent_id: finalAgentId,
        id_string: id.string,
        rev_share: id.rev,
        prime49: id.prime || false,
        status: 'active',
        parent_config_id: id.parent_config_id ? (parentLookup[id.parent_config_id] || null) : null
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

        // --- ACTION: GET ALL STATS (for page-level trend calculation) ---
if (action === 'get_all_stats') {
    try {
        // Single query - Supabase returns up to 1000 rows by default
        // Use limit(5000) to get all stats at once without chunking
        const { data, error } = await supabase
            .from('merchant_stats_by_id')
            .select('agent_id, merchant_count, total_volume_sum, total_volume_90d_sum, pending_count, closed_count, risk_count')
            .limit(5000);
        if (error) throw error;
        return res.status(200).json({ success: true, data: data || [] });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}

        // --- ACTION: GET COMPANIES (for wizard search) ---
        if (action === 'get_companies') {
            const { data, error } = await supabase
                .from('companies')
                .select('id, company_name')
                .order('company_name');
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        // --- ACTION: GET PARTNERS LIST - server assembled ---
        if (action === 'get_partners_list') {
            // 1. Fetch all base data in parallel
            const [persons, agents, companies] = await Promise.all([
                supabase.from('persons').select('id, full_name, email, phone_number, hl_contact_id, enrolled_at, is_portal_active, portal_password_set, last_portal_login').then(r => r.data || []),
                supabase.from('agents').select('id, company_id, parent_agent_id').then(r => r.data || []),
                supabase.from('companies').select('id, company_name').then(r => r.data || [])
            ]);

            // 2. Fetch identifiers only for agents we have
            const agentIds = agents.map(a => a.id);
            let identifiers = [];
            if (agentIds.length > 0) {
                const { data } = await supabase
                    .from('agent_identifiers')
                    .select('id, agent_id, id_string, rev_share, prime49, parent_config_id')
                    .in('agent_id', agentIds);
                identifiers = data || [];
            }

            // 3. Assemble partner objects server-side (reliable, no JS quirks)
            const companyMap = {};
            companies.forEach(c => { companyMap[c.id] = c.company_name; });

            const partners = persons.map(person => {
                const myAgents = agents.filter(a => a.parent_agent_id === person.id);
                if (myAgents.length === 0) return null;

                const companies_out = [];
                myAgents.forEach(agent => {
                    const myIds = identifiers.filter(i => i.agent_id === agent.id);
                    if (myIds.length === 0) return;
                    const coName = companyMap[agent.company_id] || 'Independent';
                    companies_out.push({
                        name: coName,
                        ids: myIds.map(i => ({
                            db_id: i.id,
                            string: i.id_string,
                            rev: i.rev_share || '0',
                            isPrime: !!i.prime49,
                            parent_config_id: i.parent_config_id || null,
                            sub_ids: []
                        }))
                    });
                });

                if (companies_out.length === 0) return null;

                return {
                    id: person.id,
                    name: person.full_name,
                    email: person.email || '',
                    phone: person.phone_number || '',
                    hl_id: person.hl_contact_id || null,
                    enrolled_at: person.enrolled_at || null,
                    portal_active: person.is_portal_active || false,
                    portal_setup: person.portal_password_set || false,
                    last_portal_login: person.last_portal_login || null,
                    companies: companies_out
                };
            }).filter(Boolean);

            return res.status(200).json({ success: true, partners });
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
