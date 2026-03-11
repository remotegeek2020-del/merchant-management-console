import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    // Vercel automatically injects these from your Environment Variables
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    // Extracting parameters from request body
    const { 
        action, 
        query, 
        filterBy, 
        page = 0, 
        limit = 15, 
        sortBy = 'created_at' 
    } = req.body;

    try {
        if (action === 'list') {
            // Building the query with hierarchical joins for Partner/Company info
            let request = supabase
                .from('merchants')
                .select(`
                    *,
                    agent_identifiers!agent_id (
                        id_string,
                        agents (
                            agent_name,
                            companies (
                                company_name,
                                company_person_mapping (
                                    persons (
                                        full_name
                                    )
                                )
                            )
                        )
                    )
                `, { count: 'exact' }); // Requesting exact count for the pagination display

            // 1. Handle Pagination Range
            request = request.range(page * limit, (page + 1) * limit - 1);

            // 2. Handle Sorting (Recently Created vs Recently Updated)
            request = request.order(sortBy, { ascending: false });

            // 3. Handle Targeted Search Filters
            if (query && filterBy) {
                switch (filterBy) {
                    case 'dba_name':
                        request = request.ilike('dba_name', `%${query}%`);
                        break;
                    case 'merchant_id':
                        request = request.eq('merchant_id', query);
                        break;
                    case 'agent_id':
                        request = request.eq('agent_id', query);
                        break;
                    case 'partner_name':
                        // Filtering through the nested join for the Partner's Full Name
                        request = request.filter(
                            'agent_identifiers.agents.companies.company_person_mapping.persons.full_name', 
                            'ilike', 
                            `%${query}%`
                        );
                        break;
                    default:
                        // Fallback if filter is invalid
                        request = request.or(`dba_name.ilike.%${query}%,merchant_id.ilike.%${query}%,agent_id.ilike.%${query}%`);
                }
            } else if (query) {
                // Default global search across primary fields if no specific filter is selected
                request = request.or(`dba_name.ilike.%${query}%,merchant_id.ilike.%${query}%,agent_id.ilike.%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;

            // Simplify the complex join structure for the frontend table
            const simplifiedData = data.map(m => {
                const agentInfo = m.agent_identifiers?.agents;
                const companyInfo = agentInfo?.companies;
                const personInfo = companyInfo?.company_person_mapping?.[0]?.persons;

                return {
                    ...m,
                    company_name: companyInfo?.company_name || 'Legacy/Unassigned',
                    partner_name: personInfo?.full_name || 'System'
                };
            });

            // Returning data and the total count for the "Total Records" display
            return res.status(200).json({ 
                success: true, 
                data: simplifiedData, 
                count: count 
            });
        }
    } catch (err) {
        console.error("Merchant API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
