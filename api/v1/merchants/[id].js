import { createClient } from '@supabase/supabase-js';
import { validateApiKey } from '../_auth.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function getAgentIdStrings(personId) {
    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    if (!agents?.length) return [];
    const agentUuids = agents.map(a => a.id);
    const { data: identifiers } = await supabase.from('agent_identifiers').select('id_string').in('agent_id', agentUuids);
    return (identifiers || []).map(i => i.id_string);
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== 'GET') return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this endpoint.' } });

    const ctx = await validateApiKey(req, res);
    if (!ctx) return;

    const { id } = req.query;
    if (!id) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAM', message: 'Merchant ID required in path.' } });

    const idStrings = await getAgentIdStrings(ctx.owner_id);

    // Accept either UUID (id column) or merchant_id string
    const isUuid = /^[0-9a-f-]{36}$/i.test(id);
    const lookupField = isUuid ? 'id' : 'merchant_id';

    const { data: merchant, error } = await supabase.from('merchants')
        .select('id, merchant_id, dba_name, account_status, agent_id, enrollment_date, approved_date, volume_mtd, volume_30_day, volume_90_day, email, merchant_phone, merchant_address, merchant_city, merchant_state, merchant_zip')
        .eq(lookupField, id)
        .maybeSingle();

    if (error || !merchant) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Merchant not found.' } });
    if (!idStrings.includes(merchant.agent_id)) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'This merchant does not belong to your account.' } });

    // Fetch related data in parallel
    const [equipRes, notesRes, ticketsRes] = await Promise.all([
        supabase.from('equipments').select('id, serial_number, terminal_type, status, current_location').eq('merchant_id', merchant.id),
        supabase.from('merchant_notes').select('id, title, body, created_at, created_by').eq('merchant_id', merchant.id).order('created_at', { ascending: false }).limit(10),
        supabase.from('support_tickets').select('id, ticket_number, subject, status, priority, created_at').eq('merchant_id', merchant.id).order('created_at', { ascending: false }).limit(10)
    ]);

    return res.json({
        success: true,
        data: {
            ...merchant,
            equipment: equipRes.data || [],
            recent_notes: notesRes.data || [],
            recent_tickets: ticketsRes.data || []
        }
    });
}
