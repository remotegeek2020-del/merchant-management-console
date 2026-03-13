import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            let dataReq = supabase.from('merchants').select(`
                *,
                agent_identifiers!agent_id (
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

            if (statusFilter) dataReq.eq('account_status', statusFilter);
            
            if (query && filterBy) {
                if (filterBy === 'dba_name') dataReq.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') dataReq.eq('merchant_id', query);
                else if (filterBy === 'agent_id') dataReq.eq('agent_id', query);
                else if (filterBy === 'company_name') dataReq.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                else if (filterBy === 'partner_name') dataReq.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
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

            // CRITICAL: This is the part that was missing in your console log
            const formattedData = (dataRes.data || []).map(m => {
                const company = m.agent_identifiers?.agents?.companies?.company_name || '---';
                const partner = m.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons?.full_name || '---';
                return {
                    ...m,
                    company_name: company,
                    partner_name: partner
                };
            });

            return res.status(200).json({ 
                success: true, 
                data: formattedData,
                count: dataRes.count,
                metrics: { 
                    totalMTD: stats.out_mtd, 
                    total30D: stats.out_30d, 
                    total90D: stats.out_90d, 
                    portfolioShare: stats.out_global_mtd > 0 ? ((stats.out_mtd / stats.out_global_mtd) * 100).toFixed(2) : "0.00" 
                }
            });
        }
        
        // ... (Keep your other actions: update, get_notes, etc.)
        if (action === 'get_notes') {
            const { data, error } = await supabase.from('merchant_notes').select('*').eq('merchant_id', req.body.merchant_uuid).order('created_at', { ascending: false });
            return res.status(200).json({ success: true, data });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
