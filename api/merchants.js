import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // --- 1. DEFINE THE SELECT STRINGS ---
            // Table view needs everything
            let tableSelect = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            // Volume view only needs the numbers and the join for filtering
            let volSelect = `volume_mtd, volume_30_day, volume_90_day, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;

            // --- 2. APPLY THE SEARCH LOCK ---
            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            if (isDeepSearch) {
                tableSelect = tableSelect.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
                volSelect = volSelect.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // --- 3. THE THREE-WAY QUERY ---
            // A: The Paginated Data
            let dataReq = supabase.from('merchants').select(tableSelect, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            dataReq = dataReq.range(page * pageSize, (page + 1) * pageSize - 1).order('created_at', { ascending: false });

            // B: Filtered Global Volume (Ignore Range)
            let volReq = supabase.from('merchants').select(volSelect);

            // C: Absolute Database Volume (NO FILTERS ALLOWED HERE)
            let absReq = supabase.from('merchants').select('volume_mtd');

            // --- 4. APPLY FILTERS TO A AND B ONLY ---
            [dataReq, volReq].forEach(q => {
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (filterBy === 'company_name') q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            // Execute
            const [dataRes, volRes, absRes] = await Promise.all([dataReq, volReq, absReq]);
            
            if (dataRes.error) throw dataRes.error;

            // --- 5. CALCULATE METRICS ---
            const filteredMTD = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const filtered30 = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_30_day) || 0), 0);
            const filtered90 = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_90_day) || 0), 0);
            
            // Fixed: This absolute sum is the total of EVERYTHING in your DB
            const totalDbMTD = (absRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const portfolioShare = totalDbMTD > 0 ? ((filteredMTD / totalDbMTD) * 100).toFixed(2) : 0;

            // --- 6. SAFE MAPPING ---
            const simplifiedData = (dataRes.data || []).map(m => {
                // Safely dig for the names to prevent "Error loading data"
                const agent = m.agent_identifiers?.agents;
                const company = agent?.companies;
                const person = company?.company_person_mapping?.[0]?.persons;

                return {
                    ...m,
                    company_name: company?.company_name || '---',
                    partner_name: person?.full_name || '---'
                };
            });

            return res.status(200).json({ 
                success: true, 
                data: simplifiedData, 
                count: dataRes.count,
                metrics: { totalMTD: filteredMTD, total30D: filtered30, total90D: filtered90, portfolioShare }
            });

        }
        
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        console.error("API Crash Log:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
