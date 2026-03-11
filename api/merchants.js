import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. LOCKED SEARCH LOGIC
            let selectString = `*, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )`;
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // 2. QUERY A: PAGINATED TABLE DATA
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            dataReq = dataReq.range(page * pageSize, (page + 1) * pageSize - 1).order('created_at', { ascending: false });

            // 3. QUERY B: FILTERED GLOBAL METRICS
            let volReq = supabase.from('merchants').select('volume_mtd, volume_30_day, volume_90_day, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )');
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                volReq = volReq.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // 4. QUERY C: ABSOLUTE DATABASE TOTAL (FOR %)
            let absReq = supabase.from('merchants').select('volume_mtd');

            // Apply filters to A and B
            [dataReq, volReq].forEach(q => {
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (filterBy === 'company_name') q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            const [dataRes, volRes, absRes] = await Promise.all([dataReq, volReq, absReq]);
            if (dataRes.error) throw dataRes.error;

            // Calculations
            const filteredMTD = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const filtered30 = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_30_day) || 0), 0);
            const filtered90 = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_90_day) || 0), 0);
            const absoluteMTD = (absRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);
            const portfolioShare = absoluteMTD > 0 ? ((filteredMTD / absoluteMTD) * 100).toFixed(2) : 0;

            const simplifiedData = (dataRes.data || []).map(m => {
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
                count: dataRes.count,
                metrics: { totalMTD: filteredMTD, total30D: filtered30, total90D: filtered90, portfolioShare }
            });
        }
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }
    } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
}
