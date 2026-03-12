if (action === 'list') {
            // 1. SELECT STRING SETUP (LOCKED SEARCH LOGIC)
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

            // 2. INITIALIZE REQUESTS
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            
            // MATH FIX: We only select the volume columns to prevent memory timeouts
            let volReq = supabase.from('merchants').select(`volume_mtd, volume_30_day, volume_90_day, ${selectString.split('*,')[1]}`);
            
            // 3. APPLY FILTERS
            [dataReq, volReq].forEach(q => {
                if (statusFilter) q.eq('account_status', statusFilter);
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (filterBy === 'company_name') q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            // 4. EXECUTE (Limit volReq to 20k rows for stability on 99k total)
            const [dataRes, volRes, absRes] = await Promise.all([
                dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
                volReq.limit(20000), 
                supabase.from('merchants').select('volume_mtd')
            ]);

            if (dataRes.error) throw dataRes.error;

            // 5. STABLE MATH
            const vData = volRes.data || [];
            const fMTD = vData.reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const f30 = vData.reduce((sum, m) => sum + (parseFloat(m.volume_30_day) || 0), 0);
            const f90 = vData.reduce((sum, m) => sum + (parseFloat(m.volume_90_day) || 0), 0);

            // Portfolio Share (Filtered MTD vs Total Database MTD)
            const absoluteMTD = (absRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const share = absoluteMTD > 0 ? ((fMTD / absoluteMTD) * 100).toFixed(2) : 0;

            return res.status(200).json({ 
                success: true, 
                data: (dataRes.data || []).map(m => ({
                    ...m,
                    company_name: m.agent_identifiers?.agents?.companies?.company_name || '---',
                    partner_name: m.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons?.full_name || '---'
                })),
                count: dataRes.count,
                metrics: { totalMTD: fMTD, total30D: f30, total90D: f90, portfolioShare: share }
            });
        }
