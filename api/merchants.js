import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, id, payload, userEmail, query, filterBy, page = 0, limit = 15 } = req.body;

    try {
        // --- ACTION: LIST ---
        if (action === 'list') {
            let selectString = `*, agent_identifiers!agent_id ( agents ( company_person_mapping ( persons ( full_name ) ), companies ( company_name ) ) )`;
            
            if (query && (filterBy === 'company_name' || filterBy === 'partner_name')) {
                selectString = selectString.replace(/agent_identifiers!agent_id \(/g, 'agent_identifiers!agent_id !inner (');
            }

            let request = supabase.from('merchants').select(selectString, { count: 'exact' });
            request = request.range(page * limit, (page + 1) * limit - 1).order('created_at', { ascending: false });

            if (query && filterBy) {
                if (filterBy === 'dba_name') request = request.ilike('dba_name', `%${query}%`);
                else if (filterBy === 'merchant_id') request = request.eq('merchant_id', query);
                else if (filterBy === 'agent_id') request = request.eq('agent_id', query);
                else if (filterBy === 'company_name') request = request.ilike('agent_identifiers.agents.companies.company_name', `%${query}%`);
                else if (filterBy === 'partner_name') request = request.ilike('agent_identifiers.agents.company_person_mapping.persons.full_name', `%${query}%`);
            }

            const { data, count, error } = await request;
            if (error) throw error;

            const simplifiedData = data.map(m => ({
                ...m,
                company_name: m.agent_identifiers?.agents?.companies?.company_name || 'Unassigned',
                partner_name: m.agent_identifiers?.agents?.company_person_mapping?.[0]?.persons?.full_name || 'System'
            }));

            return res.status(200).json({ success: true, data: simplifiedData, count });
        }

        // --- ACTION: UPDATE ---
        if (action === 'update') {
            const { error } = await supabase.from('merchants').update(payload).eq('id', id);
            if (error) throw error;
            
            await supabase.from('activity_logs').insert([{
                email: userEmail || 'System',
                action: `Updated Merchant: ${payload.dba_name || id}`,
                status: 'SUCCESS'
            }]);
            return res.status(200).json({ success: true });
        }

        // --- ACTION: DELETE ---
        if (action === 'delete') {
            const { error } = await supabase.from('merchants').delete().eq('id', id);
            if (error) throw error;

            await supabase.from('activity_logs').insert([{
                email: userEmail || 'System',
                action: `Deleted Merchant ID: ${id}`,
                status: 'SUCCESS'
            }]);
            return res.status(200).json({ success: true });
        }

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
}
