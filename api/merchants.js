import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, query, filterBy, statusFilter, page = 0, limit = 20 } = req.body;

    try {
        // --- ACTION: LIST (PAGINATED + FILTERED) ---
        if (action === 'list') {
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

            // Data and Volume Queries
            let dataReq = supabase.from('merchants').select(selectString, { count: 'exact' });
            let volReq = supabase.from('merchants').select('volume_mtd, volume_30_day, volume_90_day');

            [dataReq, volReq].forEach(q => {
                if (statusFilter) q.eq('account_status', statusFilter);
                if (query && filterBy) {
                    if (filterBy === 'dba_name') q.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') q.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') q.eq('agent_id', query);
                    else if (isDeepSearch) {
                        if (filterBy === 'company_name') q.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                        if (filterBy === 'partner_name') q.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                    }
                }
            });

            const [dataRes, volRes, absRes] = await Promise.all([
                dataReq.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false }),
                volReq.limit(10000), // Stability limit for math
                supabase.from('merchants').select('volume_mtd')
            ]);

            if (dataRes.error) throw dataRes.error;

            // Math Calculation
            const m = volRes.data || [];
            const fMTD = m.reduce((s, x) => s + (parseFloat(x.volume_mtd) || 0), 0);
            const totalAbs = (absRes.data || []).reduce((s, x) => s + (parseFloat(x.volume_mtd) || 0), 0);

            return res.status(200).json({ 
                success: true, 
                data: (dataRes.data || []).map(row => ({
                    ...row,
                    company_name: row.agent_identifiers?.agents?.companies?.company_name || '---',
                    partner_name: row.agent_identifiers?.agents?.companies?.company_person_mapping?.[0]?.persons?.full_name || '---'
                })),
                count: dataRes.count,
                metrics: { 
                    totalMTD: fMTD, 
                    total30D: m.reduce((s, x) => s + (parseFloat(x.volume_30_day) || 0), 0), 
                    total90D: m.reduce((s, x) => s + (parseFloat(x.volume_90_day) || 0), 0), 
                    portfolioShare: totalAbs > 0 ? ((fMTD / totalAbs) * 100).toFixed(2) : 0 
                }
            });
        }

        // --- ACTION: UPDATE (SURGICAL) ---
        if (action === 'update') {
            if (!id) return res.status(400).json({ success: false, message: "Missing Merchant ID" });

            const { error } = await supabase
                .from('merchants')
                .update(payload)
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        console.error("API Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
