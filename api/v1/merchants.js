import { createClient } from '@supabase/supabase-js';
import { validateApiKey } from './_auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function getAgentIds(personId) {
    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    if (!agents?.length) return { agentUuids: [], idStrings: [] };
    const agentUuids = agents.map(a => a.id);
    const { data: identifiers } = await supabase.from('agent_identifiers').select('id_string').in('agent_id', agentUuids);
    return { agentUuids, idStrings: (identifiers || []).map(i => i.id_string) };
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'GET') return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this endpoint.' } });

    const ctx = await validateApiKey(req, res);
    if (!ctx) return;

    const { idStrings } = await getAgentIds(ctx.owner_id);

    const page  = Math.max(0, parseInt(req.query.page  || '0'));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25')));
    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();

    if (!idStrings.length) {
        return res.json({ success: true, data: [], meta: { page, limit, total: 0, has_more: false } });
    }

    let query = supabase.from('merchants')
        .select('id, merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_mtd, volume_30_day, volume_90_day, email, merchant_phone, merchant_city, merchant_state', { count: 'exact' })
        .in('agent_id', idStrings)
        .order('dba_name')
        .range(page * limit, (page + 1) * limit - 1);

    if (status) query = query.eq('account_status', status);
    if (search) query = query.ilike('dba_name', `%${search}%`);

    const { data, count, error } = await query;
    if (error) return res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: error.message } });

    return res.json({
        success: true,
        data: data || [],
        meta: { page, limit, total: count || 0, has_more: (page + 1) * limit < (count || 0) }
    });
}
