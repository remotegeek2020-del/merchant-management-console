import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, userEmail, query, filterBy, page = 0, limit = 20 } = req.body;

    try {
        if (action === 'list') {
            // 1. SELECT EVERYTHING (*) PLUS JOINS
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

            // THE FIX FOR SEARCH: Use !inner only for specific joined searches
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // --- QUERY A: PAGINATED TABLE DATA ---
            let dataRequest = supabase.from('merchants').select(selectString, { count: 'exact' });
            const pageSize = parseInt(limit) || 20;
            dataRequest = dataRequest.range(page * pageSize, (page + 1) * pageSize - 1);
            dataRequest = dataRequest.order('created_at', { ascending: false });

            // --- QUERY B: GLOBAL VOLUME CALCULATION ---
            // We use a lighter select here because we only need the volume to sum up
            let volRequest = supabase.from('merchants').select('volume_mtd, agent_identifiers!agent_id ( agents ( companies ( company_name, company_person_mapping ( persons ( full_name ) ) ) ) )');
            
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                volRequest = volRequest.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            // Apply Filters to BOTH
            [dataRequest, volRequest].forEach(reqObj => {
                if (query && filterBy) {
                    if (filterBy === 'dba_name') reqObj.ilike('dba_name', `%${query}%`);
                    else if (filterBy === 'merchant_id') reqObj.eq('merchant_id', query);
                    else if (filterBy === 'agent_id') reqObj.eq('agent_id', query);
                    else if (filterBy === 'company_name') reqObj.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                    else if (filterBy === 'partner_name') reqObj.ilike('agent_identifiers.agents.companies.company_person_mapping.persons.full_name', `%${query}%`);
                }
            });

            // Run both in parallel for speed
            const [dataRes, volRes] = await Promise.all([dataRequest, volRequest]);
            
            if (dataRes.error) throw dataRes.error;
            if (volRes.error) throw volRes.error;

            // Calculate GLOBAL total volume (ignores pagination)
            const globalMTD = (volRes.data || []).reduce((sum, m) => sum + (parseFloat(m.volume_mtd) || 0), 0);

            // Map data while preserving ALL original fields (m)
            const simplifiedData = (dataRes.data || []).map(m => {
                const agent = m.agent_identifiers?.agents;
                const company = agent?.companies;
                const person = company?.company_person_mapping?.[0]?.persons;

                return {
                    ...m, // This spreads all 38+ fields from the DB
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

        // --- UPDATE ACTION ---
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- DELETE ACTION ---
        if (action === 'delete') {
            const { error } = await supabase.from('merchants').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
