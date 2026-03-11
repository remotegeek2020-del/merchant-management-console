import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;

            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // --- QUERY 1: FETCH PAGINATED DATA ---
            let request = supabase.from('merchants').select(selectString, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            request = request.range(page * pageSize, (page + 1) * pageSize - 1);
            request = request.order('created_at', { ascending: false });

            // --- QUERY 2: FETCH TOTAL VOLUME FOR SUMMARY ---
            // We create a second request to sum everything matching the filter (ignoring pagination)
            let sumRequest = supabase.from('merchants').select('volume_mtd, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )');

            // Apply Filters to BOTH requests
            [request, sumRequest].forEach(reqObj => {
                if (query && filterBy) {
                    if (filterBy === 'dba_name') reqObj.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') reqObj.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') reqObj.eq('agent_id', query);
                    else if (filterBy === 'company_name') reqObj.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') reqObj.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            const { data, count, error } = await request;
            const { data: sumData, error: sumError } = await sumRequest;
            
            if (error) throw error;
            if (sumError) throw sumError;

            // Calculate True Total Volume across all matched records
            const trueTotalVolumeMTD = (sumData || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);

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
                totalVolumeMTD: trueTotalVolumeMTD // This is now the "Global" filter total
            });
        }
        
        // ... (Update/Delete actions remain same) ...
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
