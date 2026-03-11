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

            // --- QUERY 1: THE TABLE DATA (PAGINATED) ---
            let request = supabase.from('merchants').select(selectString, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            request = request.range(page * pageSize, (page + 1) * pageSize - 1);
            request = request.order('created_at', { ascending: false });

            // --- QUERY 2: THE GLOBAL TOTAL (ALL RECORDS MATCHING FILTER) ---
            // We use a separate query to get EVERY record's volume for this filter
            let totalRequest = supabase.from('merchants').select('volume_mtd, agent_identifiers!agent_id!inner(agents!inner(companies!inner(company_name, company_person_mapping!inner(persons!inner(full_name)))))');

            // Apply Filters to BOTH
            [request, totalRequest].forEach(reqObj => {
                if (query && filterBy) {
                    if (filterBy === 'dba_name') reqObj.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') reqObj.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') reqObj.eq('agent_id', query);
                    else if (filterBy === 'company_name') reqObj.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') reqObj.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            const { data, count, error } = await request;
            // We fetch the volume column only to keep it fast
            const { data: volumeData, error: vError } = await totalRequest;

            if (error) throw error;

            // Perform the global sum
            const globalMTD = (volumeData || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);

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
                totalVolumeMTD: globalMTD // This is now truly global for the filter
            });
        }
        
        // ... (Keep Update/Delete logic as is)
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
