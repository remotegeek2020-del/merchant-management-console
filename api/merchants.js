import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20, user } = req.body;

    try {
        // --- ACTION: LIST MERCHANTS ---
        if (action === 'list') {
            // We use standard joins (!) to ensure we get all records, 
            // but we will use the .filter() method for nested searching.
            let dataReq = supabase.from('merchants').select(`
                *,
                agent_identifiers (
                    agents ( 
                        companies ( 
                            company_name, 
                            company_person_mapping ( 
                                persons ( full_name ) 
                            ) 
                        ) 
                    )
                )
            `, { count: 'exact' });

            // 1. Apply Status Filter
            if (statusFilter) dataReq = dataReq.eq('account_status', statusFilter);

            // 2. Dynamic Search Logic
            if (query && filterBy) {
                if (filterBy === 'dba_name') {
                    dataReq = dataReq.ilike('dba_name', `%${query}%`);
                } else if (filterBy === 'merchant_id') {
                    dataReq = dataReq.eq('merchant_id', query);
                } else if (filterBy === 'agent_id') {
                    dataReq = dataReq.eq('agent_id', query);
                } 
                // DYNAMIC NESTED FILTERING:
                // These use the full path to filter against ANY agent or company tied to the merchant.
                else if (filterBy === 'company_name') {
                    dataReq = dataReq.filter('agent_identifiers.agents.companies.company_name', 'ilike', `%${query}%`);
                } else if (filterBy === 'partner_name') {
                    dataReq = dataReq.filter('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', 'ilike', `%${query}%`);
                }
            }

            const [dataRes, mathRes] = await Promise.all([
                dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
                supabase.rpc('get_merchant_metrics', { 
                    p_status_filter: statusFilter || null, 
                    p_query: query || null, 
                    p_filter_by: filterBy || null 
                })
            ]);

            if (dataRes.error) throw dataRes.error;
            const stats = mathRes.data?.[0] || { out_mtd: 0, out_30d: 0, out_90d: 0, out_global_mtd: 0 };
            
            return res.status(200).json({ 
                success: true, 
                data: dataRes.data,
                count: dataRes.count,
                metrics: { 
                    totalMTD: stats.out_mtd, 
                    total30D: stats.out_30d, 
                    total90D: stats.out_90d, 
                    portfolioShare: stats.out_global_mtd > 0 ? ((stats.out_mtd / stats.out_global_mtd) * 100).toFixed(2) : "0.00" 
                }
            });
        }

        // --- ACTION: UPDATE MERCHANT ---
        if (action === 'update') {
            const { error: updateError } = await supabase.from('merchants').update(payload).eq('id', id);
            if (updateError) throw updateError;
            return res.status(200).json({ success: true });
        }

        // --- NOTE ACTIONS ---
        if (action === 'get_notes') {
            const { data, error } = await supabase.from('merchant_notes')
                .select('*')
                .eq('merchant_id', req.body.merchant_uuid)
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
