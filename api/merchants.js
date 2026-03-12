if (action === 'list') {
    // 1. DATA FETCH (For the Table)
    let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
    
    // Check if we need inner joins for deep searching
    const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
    if (isDeepSearch) {
        selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (')
                                   .replace(/agents \(/g, 'agents !inner (')
                                   .replace(/companies \(/g, 'companies !inner (')
                                   .replace(/company_person_mapping \(/g, 'company_person_mapping !inner (')
                                   .replace(/persons \(/g, 'persons !inner (');
    }

    let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });

    // Apply Standard Filters
    if (statusFilter) dataReq.eq('account_status', statusFilter);
    if (query && filterBy) {
        if (filterBy === 'dba_name') dataReq.ilike('dba_name', `%${query}%`);
        else if (filterBy === 'merchant_id') dataReq.eq('merchant_id', query);
        else if (filterBy === 'agent_id') dataReq.eq('agent_id', query);
        else if (filterBy === 'company_name') dataReq.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
        else if (filterBy === 'partner_name') dataReq.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
    }

    // 2. MATH FETCH (Using the RPC we just fixed)
    const [dataRes, mathRes] = await Promise.all([
        dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
        supabase.rpc('get_merchant_metrics', { 
            p_status_filter: statusFilter || null, 
            p_query: query || null, 
            p_filter_by: filterBy || null 
        })
    ]);

    // Handle Data Errors
    if (dataRes.error) {
        console.error("Data Fetch Error:", dataRes.error);
        return res.status(500).json({ success: false, message: dataRes.error.message });
    }

    // Process Metrics Safely
    const stats = (mathRes.data && mathRes.data[0]) ? mathRes.data[0] : { f_mtd: 0, f_30d: 0, f_90d: 0, g_mtd: 0 };
    const share = stats.g_mtd > 0 ? ((stats.f_mtd / stats.g_mtd) * 100).toFixed(2) : "0.00";

    return res.status(200).json({ 
        success: true, 
        data: (dataRes.data || []).map(m => ({
            ...m,
            company_name: m.agent_identifiers?.agents?.companies?.company_name || '---',
            partner_name: m.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons?.full_name || '---'
        })),
        count: dataRes.count,
        metrics: { 
            totalMTD: stats.f_mtd || 0, 
            total30D: stats.f_30d || 0, 
            total90D: stats.f_90d || 0, 
            portfolioShare: share 
        }
    });
}
