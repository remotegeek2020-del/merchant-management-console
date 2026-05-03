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
    const { person, company, identifiers, isQuickAdd, isQuickAddNewAgent, existingAgentId } = body;
    let finalAgentId = existingAgentId;

    // Quick add to a NEW company for an existing person
    if (isQuickAddNewAgent) {
        if (!person || !person.name) return res.status(400).json({ success: false, message: 'Missing person name.' });
        
        // Find existing person by name (they already exist)
        const { data: existingPerson } = await supabase
            .from('persons')
            .select('id')
            .ilike('full_name', person.name.trim())
            .single();

        if (!existingPerson) return res.status(400).json({ success: false, message: 'Could not find existing partner record.' });

        // Handle company
        let targetCoId = company.id || null;
        if (!targetCoId && !company.isIndependent && company.name) {
            const { data: coData } = await supabase.from('companies').insert({ company_name: company.name }).select().single();
            targetCoId = coData ? coData.id : null;
        }

        // Create new agent for this person under the new company
        const { data: agentData, error: agentErr } = await supabase.from('agents').insert({
            company_id: targetCoId,
            agent_name: person.name.trim(),
            parent_agent_id: existingPerson.id
        }).select().single();

        if (agentErr) return res.status(400).json({ success: false, message: 'Agent creation failed: ' + agentErr.message });
        finalAgentId = agentData.id;

    } else if (!isQuickAdd) {
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
                hl_contact_id: person.hl_id,
                enrolled_at: person.enrolled_at || new Date().toISOString()
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
        // --- ACTION: GET COMPANIES ---
        if (action === 'get_companies') {
            const { data } = await supabase.from('companies').select('id, company_name').order('company_name');
            return res.status(200).json({ success: true, data: data || [] });
        }

        // --- ACTION: GET PARTNER NOTES ---
        if (action === 'get_notes') {
            const { person_id } = body;
            const { data, error } = await supabase
                .from('partner_notes')
                .select('*')
                .eq('person_id', person_id)
                .order('is_pinned', { ascending: false })
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        // --- ACTION: ADD PARTNER NOTE ---
        if (action === 'add_note') {
            const { person_id, body: noteBody, note_type, author_id, author_name } = body;
            if (!noteBody?.trim()) return res.status(400).json({ success: false, message: 'Note body required.' });
            const { data, error } = await supabase.from('partner_notes').insert({
                person_id, body: noteBody.trim(), note_type: note_type || 'general',
                author_id, author_name
            }).select().single();
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        // --- ACTION: UPDATE PARTNER NOTE ---
        if (action === 'update_note') {
            const { note_id, body: noteBody, is_pinned } = body;
            const updates = {};
            if (noteBody !== undefined) updates.body = noteBody.trim();
            if (is_pinned !== undefined) updates.is_pinned = is_pinned;
            updates.updated_at = new Date().toISOString();
            const { error } = await supabase.from('partner_notes').update(updates).eq('id', note_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ACTION: DELETE PARTNER NOTE ---
        if (action === 'delete_note') {
            const { note_id } = body;
            const { error } = await supabase.from('partner_notes').delete().eq('id', note_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ACTION: GET PARTNER SCORECARD ---
        if (action === 'get_scorecard') {
            const { person_id } = body;

            const { data: agents } = await supabase
                .from('agents')
                .select('id, company_id, companies:company_id(company_name)')
                .eq('parent_agent_id', person_id);

            if (!agents || agents.length === 0) {
                return res.status(200).json({ success: true, scorecard: null });
            }

            const agentIds = agents.map(a => a.id);
            const { data: identifiers } = await supabase
                .from('agent_identifiers')
                .select('id, agent_id, id_string, rev_share, prime49')
                .in('agent_id', agentIds);

            const idStrings = (identifiers || []).map(i => i.id_string);

            const { from_date, to_date } = body;

            let topQuery = supabase.from('merchants')
                .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_id, last_batch_date')
                .in('agent_id', idStrings)
                .eq('account_status', 'Approved')
                .order('volume_30_day', { ascending: false })
                .limit(10);

            if (from_date) topQuery = topQuery.gte('last_batch_date', from_date);
            if (to_date) topQuery = topQuery.lte('last_batch_date', to_date);

            const [statsRes, topMerchantsRes] = await Promise.all([
                supabase.from('merchant_stats_by_id')
                    .select('agent_id, merchant_count, total_volume_sum, total_volume_90d_sum, pending_count, closed_count, risk_count')
                    .in('agent_id', idStrings),
                topQuery
            ]);

            const statsMap = {};
            (statsRes.data || []).forEach(s => { statsMap[s.agent_id] = s; });

            const calcTrend = (v30, v90) => {
                const avg = v90 / 3;
                return v30 > avg * 1.05 ? 'growth' : v30 < avg * 0.95 ? 'risk' : 'stable';
            };

            // ── PER-COMPANY SCORECARD ─────────────────────────
            const companies = agents.map(agent => {
                const coName = agent.companies?.company_name || 'Independent';
                const myIds = (identifiers || []).filter(i => i.agent_id === agent.id);
                const myIdStrings = myIds.map(i => i.id_string);

                let vol30 = 0, vol90 = 0, merchants = 0, pending = 0, closed = 0, risk = 0;
                myIdStrings.forEach(id => {
                    const s = statsMap[id] || {};
                    vol30 += parseFloat(s.total_volume_sum || 0);
                    vol90 += parseFloat(s.total_volume_90d_sum || 0);
                    merchants += parseInt(s.merchant_count || 0);
                    pending += parseInt(s.pending_count || 0);
                    closed += parseInt(s.closed_count || 0);
                    risk += parseInt(s.risk_count || 0);
                });

                const topForCompany = (topMerchantsRes.data || [])
                    .filter(m => myIdStrings.includes(m.agent_id))
                    .slice(0, 5);

                return {
                    company_name: coName,
                    agent_ids: myIdStrings,
                    merchants, vol30, vol90,
                    pending, closed, at_risk: risk,
                    trend: calcTrend(vol30, vol90),
                    top_merchants: topForCompany
                };
            });

            // ── OVERALL TOTALS ────────────────────────────────
            const totals = companies.reduce((acc, c) => ({
                merchants: acc.merchants + c.merchants,
                volume_30: acc.volume_30 + c.vol30,
                volume_90: acc.volume_90 + c.vol90,
                pending: acc.pending + c.pending,
                closed: acc.closed + c.closed,
                at_risk: acc.at_risk + c.at_risk
            }), { merchants: 0, volume_30: 0, volume_90: 0, pending: 0, closed: 0, at_risk: 0 });

            totals.overall_trend = calcTrend(totals.volume_30, totals.volume_90);

            return res.status(200).json({
                success: true,
                scorecard: {
                    totals,
                    companies,
                    top_merchants: (topMerchantsRes.data || [])
                }
            });
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
        // Single fast query - only 2 columns needed for trend calc
        const { data, error } = await supabase
            .from('merchant_stats_by_id')
            .select('agent_id, total_volume_sum, total_volume_90d_sum')
            .limit(5000);
        if (error) throw error;
        return res.status(200).json({ success: true, data: data || [] });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
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
                fetchAll('persons', 'id, full_name, email, phone_number, hl_contact_id, enrolled_at, is_portal_active, portal_password_set, last_portal_login'),
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
    
    // Paginate to get ALL merchants (Supabase default cap is 1000)
    let allMerchants = [];
    let from = 0;
    let done = false;
    while (!done) {
        const { data, error } = await supabase
            .from('merchants')
            .select('merchant_id, dba_name, account_status, enrollment_date, volume_30_day, volume_90_day, volume_mtd, last_batch_date, merchant_city, merchant_state, merchant_phone, email')
            .eq('agent_id', identifier_id)
            .range(from, from + 999);
        if (error || !data || data.length === 0) { done = true; }
        else {
            allMerchants = allMerchants.concat(data);
            if (data.length < 1000) done = true;
            else from += 1000;
        }
    }
    return res.status(200).json({ success: true, data: allMerchants, total: allMerchants.length });
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
