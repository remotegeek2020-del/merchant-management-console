import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. LOCKED SEARCH STRING (For the Table)
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            
            // 2. LIGHTWEIGHT VOLUME STRING (For the Math)
            // We only need the volume columns and the join path to filter correctly
            let volumeSelect = `volume_mtd, volume_30_day, volume_90_day, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;

            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            
            if (isDeepSearch) {
                const innerJoin = 'agent_identifiers!agent_id !inner ( agents !inner ( companies !inner ( company_person_mapping !inner ( persons !inner (';
                selectString = selectString.replace(/agent_identifiers!agent_id \(.*persons \(/s, innerJoin);
                volumeSelect = volumeSelect.replace(/agent_identifiers!agent_id \(.*persons \(/s, innerJoin);
            }

            // 3. PREPARE REQUESTS
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            let volReq = supabase.from('merchants').select(volumeSelect);
            let absReq = supabase.from('merchants').select('volume_mtd'); // Absolute Global Total

            // 4. APPLY FILTERS TO DATA AND VOLUME
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

            // 5. EXECUTE (Parallel for speed)
            const pageSize = parseInt(limit) || 20;
            const [dataRes, volRes, absRes] = await Promise.all([
                dataReq.range(page * pageSize, (page + 1) * pageSize - 1).order('created_at', { ascending: false }),
                volReq,
                absReq
            ]);

            if (dataRes.error) throw dataRes.error;

            // 6. CALCULATE STEADY METRICS
            const vData = volRes.data || [];
            const filteredMTD = vData.reduce((s, m) => s + (parseFloat(m.volume_mtd) || 0), 0);
            const filtered30 = vData.reduce((s, m) => s + (parseFloat(m.volume_30_day) || 0), 0);
            const filtered90 = vData.reduce((s, m) => s + (parseFloat(m.volume_90_day) || 0), 0);
            
            const absoluteMTD = (absRes.data || []).reduce((s, m) => s + (parseFloat(m.volume_mtd) || 0), 0);
            const share = absoluteMTD > 0 ? ((filteredMTD / absoluteMTD) * 100).toFixed(2) : 0;

            const simplifiedData = (dataRes.data || []).map(m => {
                const agent = m.agent_identifiers?.agents;
                const company = agent?.companies;
                const person = company?.company_person_mapping?.[0]?.persons;
                return {
                    ...m,
                    company_name: company?.company_name || '---',
                    partner_name: person?.full_name || '---'
                };
            });

            return res.status(200).json({ 
                success: true, 
                data: simplifiedData, 
                count: dataRes.count,
                metrics: { totalMTD: filteredMTD, total30D: filtered30, total90D: filtered90, portfolioShare: share }
            });
        }
        
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
