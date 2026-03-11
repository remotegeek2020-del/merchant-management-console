import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. FETCH THE TOTAL VOLUME (GLOBAL - NO LIMITS)
            // We call the RPC function we just created in Step 1
            const { data: globalVol, error: volError } = await supabase
                .rpc('get_total_merchant_volume', { 
                    search_query: query || '', 
                    filter_column: filterBy || '' 
                });

            if (volError) console.error("Volume Error:", volError);

            // 2. FETCH THE PAGINATED TABLE DATA
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            let request = supabase.from('merchants').select(selectString, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            request = request.range(page * pageSize, (page + 1) * pageSize - 1);
            request = request.order('created_at', { ascending: false });

            // Apply filters to the table view
            if (query && filterBy) {
                if (filterBy === 'dba_name') request.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') request.eq('merchant_id', query);
                else if (filterBy === 'agent_id') request.eq('agent_id', query);
                else if (filterBy === 'company_name') request.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                else if (filterBy === 'partner_name') request.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;

            const simplifiedData = (data || []).map(m => {
                const person = m.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons;
                return {
                    ...m,
                    company_name: m.agent_identifiers?.agents?.companies?.company_name || '---',
                    partner_name: person?.full_name || '---'
                };
            });

            return res.status(200).json({ 
                success: true, 
                data: simplifiedData, 
                count: count,
                totalVolumeMTD: globalVol // Truly global from the database sum function
            });
        }
        
        // ... (Keep Update/Delete logic)
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
