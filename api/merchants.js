import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, userEmail, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. SELECT STRING SETUP
            let selectString = `
                *,
                agent_identifiers!agent_id (
                    agents (
                        agent_name,
                        companies (
                            company_name,
                            company_person_mapping (
                                persons (
                                    full_name
                                )
                            )
                        )
                    )
                )
            `;

            // THE FIX: If searching by joined fields, we force the "!inner" join so Supabase filters correctly
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString
                    .replace('agent_identifiers!agent_id (', 'agent_identifiers!agent_id !inner (')
                    .replace('agents (', 'agents !inner (')
                    .replace('companies (', 'companies !inner (')
                    .replace('company_person_mapping (', 'company_person_mapping !inner (')
                    .replace('persons (', 'persons !inner (');
            }

            // 2. QUERY A: PAGINATED DATA (FOR THE TABLE)
            let dataRequest = supabase.from('merchants').select(selectString, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            dataRequest = dataRequest.range(page * pageSize, (page + 1) * pageSize - 1);
            dataRequest = dataRequest.order('created_at', { ascending: false });

            // 3. QUERY B: GLOBAL VOLUME (FOR THE KPI CARD)
            // We only need volume_mtd, but we need the same filters/joins to get the right total
            let volRequest = supabase.from('merchants').select(`volume_mtd, ${selectString.split('*,')[1]}`);

            // 4. APPLY FILTERS TO BOTH QUERIES
            [dataRequest, volRequest].forEach(reqObj => {
                if (query && filterBy) {
                    if (filterBy === 'dba_name') reqObj.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') reqObj.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') reqObj.eq('agent_id', query);
                    else if (filterBy === 'company_name') {
                        reqObj.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    } else if (filterBy === 'partner_name') {
                        reqObj.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                    }
                }
            });

            // Run both simultaneously for better performance
            const [dataRes, volRes] = await Promise.all([dataRequest, volRequest]);
            
            if (dataRes.error) throw dataRes.error;
            if (volRes.error) throw volRes.error;

            // 5. CALCULATE TRUE TOTAL VOLUME (All records matching filter)
            const globalMTD = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);

            // 6. DEFENSIVE MAPPING: Preserve all original fields for "View Details"
            const simplifiedData = (dataRes.data || []).map(m => {
                const agent = m.agent_identifiers?.agents;
                const company = agent?.companies;
                const person = company?.company_person_mapping?.[0]?.persons;

                return {
                    ...m, // This ensures every field from Supabase is passed to the modal
                    company_name: company?.company_name || '---',
                    partner_name: person?.full_name || '---'
                };
            });

            return res.status(200).json({ 
                success: true, 
                data: simplifiedData, 
                count: dataRes.count,
                totalVolumeMTD: globalMTD 
            });
        }

        // --- UPDATE LOGIC ---
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- DELETE LOGIC ---
        if (action === 'delete') {
            const { error } = await supabase.from('merchants').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
