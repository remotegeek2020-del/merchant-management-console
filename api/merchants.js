import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // --- 1. SEARCH LOGIC DEFINITION ---
            // Base string for the table view
            let tableSelect = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            
            // Base string for the Volume Sum (we only need the volume field and the join path)
            let volumeSelect = `volume_mtd, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;

            // THE FIX: If searching by Partner or Company, we MUST use !inner to filter the database
            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            if (isDeepSearch) {
                tableSelect = tableSelect.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
                volumeSelect = volumeSelect.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // --- 2. PREPARE THE DATA QUERY (PAGINATED) ---
            let dataReq = supabase.from('merchants').select(tableSelect, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            dataReq = dataReq.range(page * pageSize, (page + 1) * pageSize - 1).order('created_at', { ascending: false });

            // --- 3. PREPARE THE VOLUME QUERY (GLOBAL FOR FILTER) ---
            // This query ignores pagination (no .range) to see the WHOLE database matching the search
            let volReq = supabase.from('merchants').select(volumeSelect);

            // --- 4. APPLY FILTERS TO BOTH QUERIES ---
            [dataReq, volReq].forEach(q => {
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (filterBy === 'company_name') q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            // Run both simultaneously
            const [dataRes, volRes] = await Promise.all([dataReq, volReq]);
            
            if (dataRes.error) throw dataRes.error;
            if (volRes.error) throw volRes.error;

            // --- 5. CALCULATE TRUE TOTAL ---
            // This sums EVERY record matching the search, not just the 20 on screen
            const globalMTD = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);

            const simplifiedData = (dataRes.data || []).map(m => {
                const agent = m.agent_identifiers?.agents;
                const company = agent?.companies;
                const person = company?.company_person_mapping?.[0]?.persons;

                return {
                    ...m, // Restores all 38 fields for the modal
                    company_name: company?.company_name || '---',
                    partner_name: person?.full_name || '---'
                };
            });

            return res.status(200).json({ 
                success: true, 
                data: simplifiedData, 
                count: dataRes.count,
                totalVolumeMTD: globalMTD 
            });
        }

        // --- UPDATE & DELETE ACTIONS ---
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }
        if (action === 'delete') {
            const { error } = await supabase.from('merchants').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
