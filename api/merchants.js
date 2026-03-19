// --- ACTION: LIST MERCHANTS ---
if (action === 'list') {
    // We apply filters directly to the nested select strings to ensure the database correctly targets joined data
    const companyFilter = (filterBy === 'company_name' && query) ? `.ilike(company_name, %${query}%)` : '';
    const partnerFilter = (filterBy === 'partner_name' && query) ? `.ilike(full_name, %${query}%)` : '';

    let dataReq = supabase.from('merchants').select(`
        *,
        agent_identifiers!agent_id (
            agents ( 
                companies${companyFilter} ( 
                    company_name, 
                    company_person_mapping ( 
                        persons${partnerFilter} ( full_name ) 
                    ) 
                ) 
            )
        )
    `, { count: 'exact' });

    // Handle standard top-level filters
    if (statusFilter) dataReq = dataReq.eq('account_status', statusFilter);
    
    if (query && filterBy) {
        if (filterBy === 'dba_name') {
            dataReq = dataReq.ilike('dba_name', `%${query}%`);
        } else if (filterBy === 'merchant_id') {
            dataReq = dataReq.eq('merchant_id', query);
        } else if (filterBy === 'agent_id') {
            dataReq = dataReq.eq('agent_id', query);
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

    // POST-FILTERING: To remove merchants that don't match the nested search criteria
    let filteredData = dataRes.data;
    if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
        filteredData = dataRes.data.filter(m => {
            const comp = m.agent_identifiers?.agents?.companies;
            if (filterBy === 'company_name') return comp?.company_name;
            if (filterBy === 'partner_name') return comp?.company_person_mapping?.[0]?.persons?.full_name;
            return false;
        });
    }

    const stats = mathRes.data?.[0] || { out_mtd: 0, out_30d: 0, out_90d: 0, out_global_mtd: 0 };
    return res.status(200).json({ 
        success: true, 
        data: filteredData,
        count: dataRes.count,
        metrics: { totalMTD: stats.out_mtd, total30D: stats.out_30d, total90D: stats.out_90d, portfolioShare: stats.out_global_mtd > 0 ? ((stats.out_mtd / stats.out_global_mtd) * 100).toFixed(2) : "0.00" }
    });
}
