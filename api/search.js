import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

    const { q, userid } = req.body;
    if (!userid) return res.status(401).json({ success: false, message: 'Unauthorized' });
    if (!q || q.trim().length < 2) return res.status(400).json({ success: false, message: 'Query too short' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const term = q.trim();
    const like = `%${term}%`;

    // Verify user is active
    const { data: user } = await supabase.from('app_users').select('role, is_active').eq('userid', userid).single();
    if (!user?.is_active) return res.status(403).json({ success: false, message: 'Access denied' });

    const isAdmin = ['super_admin', 'admin', 'manager'].includes(user.role);

    try {
        const [merchantsRes, partnersRes, ticketsRes, equipmentRes] = await Promise.all([
            // Merchants: search dba_name, merchant_id, company_name
            supabase.from('merchants')
                .select('merchant_id, dba_name, company_name, agent_id, account_status')
                .or(`dba_name.ilike.${like},merchant_id.ilike.${like},company_name.ilike.${like}`)
                .limit(5),

            // Partners (persons): search full_name, email
            isAdmin
                ? supabase.from('persons')
                    .select('id, full_name, email, is_portal_active')
                    .or(`full_name.ilike.${like},email.ilike.${like}`)
                    .limit(5)
                : Promise.resolve({ data: [] }),

            // Tickets: search ticket_number, subject
            supabase.from('tickets')
                .select('id, ticket_number, subject, status, priority')
                .or(`ticket_number.ilike.${like},subject.ilike.${like}`)
                .order('created_at', { ascending: false })
                .limit(5),

            // Equipment: search serial_number, terminal_type
            isAdmin
                ? supabase.from('equipments')
                    .select('id, serial_number, terminal_type, status, current_location')
                    .or(`serial_number.ilike.${like},terminal_type.ilike.${like}`)
                    .limit(5)
                : Promise.resolve({ data: [] }),
        ]);

        return res.status(200).json({
            success: true,
            results: {
                merchants: merchantsRes.data || [],
                partners:  partnersRes.data  || [],
                tickets:   ticketsRes.data   || [],
                equipment: equipmentRes.data || [],
            }
        });
    } catch (err) {
        console.error('Search API error:', err.message);
        return res.status(500).json({ success: false, message: 'Search failed' });
    }
}
