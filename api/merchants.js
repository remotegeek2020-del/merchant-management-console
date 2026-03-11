import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. LOCKED SEARCH STRING (For Table)
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            
            // 2. LIGHTWEIGHT VOLUME STRING (For Math)
            let volSelect = `volume_mtd, volume_30_day, volume_90_day, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;

            const isDeepSearch = (query && (filterBy === 'company_name' || filterBy === 'partner_name'));
            
            if (isDeepSearch) {
                // Force !inner joins to ensure the filter works across tables
                const innerReplacer = (str) => str
                    .replace('agent_identifiers!agent_id (', 'agent_identifiers!agent_id !inner (')
                    .replace('agents (', 'agents !inner (')
                    .replace('companies (', 'companies !inner (')
                    .replace('company_person_mapping (', 'company_person_mapping !inner (')
                    .replace('persons (', 'persons !inner (');
                
                selectString = innerReplacer(selectString);
                volSelect = innerReplacer(volSelect);
            }

            // 3. INITIALIZE QUERIES
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            let volReq = supabase.from('merchants').select(volSelect);
            let absReq = supabase.from('merchants').select('volume_mtd'); // For Portfolio Share

            // 4. APPLY FILTERS (SEARCH + STATUS)
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

            // 5. EXECUTE ALL IN PARALLEL
            const pageSize = parseInt(limit) || 20;
            const [dataRes, volRes, absRes] = await Promise.all([
                dataReq.range(page * pageSize, (page + 1) * pageSize - 1).order('created_at', { ascending: false }),
                volReq,
                absReq
            ]);

            if (dataRes.error) throw dataRes.error;

            // 6. CALCULATE NUMBERS (Failsafe Math)
            const vData = volRes.data || [];
            let fMTD = 0, f30 = 0, f90 = 0;

            vData.forEach(m => {
                fMTD += parseFloat(m.volume_mtd) || 0;
                f30 += parseFloat(m.volume_30_day) || 0;
                f90 += parseFloat(m.volume_90_day) || 0;
            });

            const absoluteMTD = (absRes.data || []).reduce((s, m) => s + (parseFloat(m.volume_mtd) || 0), 0);
            const share = absoluteMTD > 0 ? ((fMTD / absoluteMTD) * 100).toFixed(2) : 0;

            // 7. SAFE MAPPING FOR TABLE
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
                metrics: { 
                    totalMTD: fMTD, 
                    total30D: f30, 
                    total90D: f90, 
                    portfolioShare: share 
                }
            });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
