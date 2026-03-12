if (action === 'list') {
            // 1. SELECT STRING (LOCKED)
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            
            if (isDeepSearch) {
                const inner = (str) => str.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (')
                                          .replace(/agents \(/g, 'agents !inner (')
                                          .replace(/companies \(/g, 'companies !inner (')
                                          .replace(/company_person_mapping \(/g, 'company_person_mapping !inner (')
                                          .replace(/persons \(/g, 'persons !inner (');
                selectString = inner(selectString);
            }

            // 2. DATA REQUEST (PAGINATED)
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            
            if (statusFilter) dataReq.eq('account_status', statusFilter);
            if (query && filterBy) {
                if (filterBy === 'dba_name') dataReq.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') dataReq.eq('merchant_id', query);
                else if (filterBy === 'agent_id') dataReq.eq('agent_id', query);
                else if (filterBy === 'company_name') dataReq.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                else if (filterBy === 'partner_name') dataReq.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
            }

            // 3. EXECUTE BOTH
            const [dataRes, metricsRes, globalRes] = await Promise.all([
                dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
                supabase.rpc('get_portfolio_metrics', { status_filter: statusFilter || null }),
                supabase.from('merchants').select('volume_mtd') // Still needed for Share %
            ]);

            if (dataRes.error) throw dataRes.error;

            // 4. STABLE MATH
            const metrics = metricsRes.data?.[0] || { total_mtd: 0, total_30d: 0, total_90d: 0 };
            const absoluteMTD = (globalRes.data || []).reduce((s, m) => s + (parseFloat(m.volume_mtd) || 0), 0);
            
            const share = absoluteMTD > 0 ? ((metrics.total_mtd / absoluteMTD) * 100).toFixed(2) : 0;

            return res.status(200).json({ 
                success: true, 
                data: (dataRes.data || []).map(m => ({
                    ...m,
                    company_name: m.agent_identifiers?.agents?.companies?.company_name || '---',
                    partner_name: m.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons?.full_name || '---'
                })),
                count: dataRes.count,
                metrics: { 
                    totalMTD: metrics.total_mtd, 
                    total30D: metrics.total_30d, 
                    total90D: metrics.total_90d, 
                    portfolioShare: share 
                }
            });
        }
