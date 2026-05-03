import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function validateSession(token) {
    if (!token) return null;
    const { data } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).single();
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

async function getAgentIds(personId) {
    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    if (!agents?.length) return { agentUuids: [], idStrings: [], identifiers: [] };
    const agentUuids = agents.map(a => a.id);
    const { data: identifiers } = await supabase.from('agent_identifiers').select('id, id_string, rev_share, prime49').in('agent_id', agentUuids);
    return { agentUuids, idStrings: (identifiers || []).map(i => i.id_string), identifiers: identifiers || [] };
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, token } = req.body || {};
    const personId = await validateSession(token);
    if (!personId) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });

    const { agentUuids, idStrings, identifiers } = await getAgentIds(personId);

    try {

        // ── DASHBOARD OVERVIEW ─────────────────────────────
        if (action === 'get_overview') {
            if (!idStrings.length) return res.status(200).json({ success: true, data: { merchants: 0, approved: 0, pending: 0, mtd: 0, vol30: 0, vol90: 0, identifiers: [] } });

            const { data: stats } = await supabase.from('merchant_stats_by_id').select('*').in('agent_id', idStrings);

            let merchants = 0, approved = 0, pending = 0, closed = 0, mtd = 0, vol30 = 0, vol90 = 0;
            (stats || []).forEach(s => {
                approved += parseInt(s.merchant_count || 0);
                pending  += parseInt(s.pending_count || 0);
                closed   += parseInt(s.closed_count || 0);
                mtd      += parseFloat(s.total_volume_sum || 0);
                vol30    += parseFloat(s.total_volume_sum || 0);
                vol90    += parseFloat(s.total_volume_90d_sum || 0);
                merchants += parseInt(s.merchant_count || 0) + parseInt(s.pending_count || 0);
            });

            // Open RMAs for this partner
            const { count: openRmas } = await supabase.from('returns').select('*', { count: 'exact', head: true }).in('merchants.agent_id', idStrings).eq('status', 'Open');

            return res.status(200).json({ success: true, data: { merchants, approved, pending, closed, mtd, vol30, vol90, open_rmas: openRmas || 0, identifiers } });
        }

        // ── MERCHANT LIST ──────────────────────────────────
        if (action === 'get_merchants') {
            const { page = 0, limit = 25, search = '', status_filter = '' } = req.body;
            if (!idStrings.length) return res.status(200).json({ success: true, data: [], count: 0 });

            let query = supabase.from('merchants')
                .select('id, merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_mtd, volume_30_day, volume_90_day, approved_date, email, merchant_phone, merchant_address, merchant_city, merchant_state', { count: 'exact' })
                .in('agent_id', idStrings);

            if (status_filter) query = query.eq('account_status', status_filter);
            if (search) query = query.ilike('dba_name', `%${search}%`);

            const { data, count, error } = await query.range(page * limit, (page + 1) * limit - 1).order('dba_name');
            if (error) throw error;

            // Get identifier details for each merchant
            const enriched = (data || []).map(m => {
                const id = identifiers.find(i => i.id_string === m.agent_id);
                return { ...m, rev_share: id?.rev_share || null, is_prime49: id?.prime49 || false };
            });

            return res.status(200).json({ success: true, data: enriched, count: count || 0 });
        }

        // ── MERCHANT DETAIL ────────────────────────────────
        if (action === 'get_merchant_detail') {
            const { merchant_uuid } = req.body;

            // Verify this merchant belongs to this partner
            const { data: merchant } = await supabase.from('merchants').select('*').eq('id', merchant_uuid).single();
            if (!merchant || !idStrings.includes(merchant.agent_id)) {
                return res.status(403).json({ success: false, message: 'Access denied.' });
            }

            // Equipment
            const { data: equipment } = await supabase.from('equipments').select('id, serial_number, terminal_type, status, current_location, received_date').eq('merchant_id', merchant_uuid);

            // Notes
            const { data: notes } = await supabase.from('merchant_notes').select('id, title, body, created_at, created_by').eq('merchant_id', merchant_uuid).order('created_at', { ascending: false });

            // RMAs
            const { data: rmas } = await supabase.from('returns').select('id, return_id, return_reason, condition, status, destination, created_at, equipments:equipment_id(serial_number, terminal_type)').eq('merchant_id', merchant_uuid).order('created_at', { ascending: false });

            return res.status(200).json({ success: true, data: { merchant, equipment: equipment || [], notes: notes || [], rmas: rmas || [] } });
        }

        // ── ADD NOTE ───────────────────────────────────────
        if (action === 'add_note') {
            const { merchant_uuid, title, body } = req.body;

            // Verify ownership
            const { data: merchant } = await supabase.from('merchants').select('agent_id').eq('id', merchant_uuid).single();
            if (!merchant || !idStrings.includes(merchant.agent_id)) return res.status(403).json({ success: false });

            const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).single();

            const { error } = await supabase.from('merchant_notes').insert({
                merchant_id: merchant_uuid,
                title: title || 'Partner Note',
                body,
                created_by: person?.full_name || 'Partner'
            });

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // ── REQUEST RMA ────────────────────────────────────
        if (action === 'request_rma') {
            const { merchant_id, equipment_serial, reason, notes } = req.body;
            if (!merchant_id || !reason) return res.status(400).json({ success: false, message: 'Merchant ID and reason required.' });

            // Verify this merchant belongs to this partner
            const { data: merchant } = await supabase.from('merchants').select('agent_id, dba_name').eq('merchant_id', merchant_id).single();
            if (!merchant || !idStrings.includes(merchant.agent_id)) return res.status(403).json({ success: false });

            const { error } = await supabase.from('partner_rma_requests').insert({
                person_id: personId,
                merchant_id,
                equipment_serial,
                reason,
                notes,
                status: 'Pending'
            });

            if (error) throw error;

            // Notify internal staff via messages table
            const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).single();
            await supabase.from('messages').insert({
                sender_id: personId,
                recipient_id: null, // broadcast to admins
                subject: `RMA Request from ${person?.full_name}`,
                body: `Partner ${person?.full_name} has submitted an RMA request for merchant ${merchant_id} (${merchant.dba_name}).\n\nEquipment: ${equipment_serial || 'Not specified'}\nReason: ${reason}\nNotes: ${notes || 'None'}`
            });

            return res.status(200).json({ success: true });
        }

        // ── GET MESSAGES ───────────────────────────────────
        if (action === 'get_messages') {
            const { data: sent } = await supabase.from('messages').select('*').eq('sender_id', personId).order('created_at', { ascending: false });
            const { data: received } = await supabase.from('messages').select('*').eq('recipient_id', personId).order('created_at', { ascending: false });

            // Merge and sort
            const all = [...(sent || []), ...(received || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            return res.status(200).json({ success: true, data: all });
        }

        // ── SEND MESSAGE ───────────────────────────────────
        if (action === 'send_message') {
            const { subject, body } = req.body;
            if (!body) return res.status(400).json({ success: false, message: 'Message body required.' });

            const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).single();

            // Find admin to send to (first super_admin)
            const { data: admin } = await supabase.from('app_users').select('userid').eq('role', 'super_admin').eq('is_active', true).single();

            const { error } = await supabase.from('messages').insert({
                sender_id: personId,
                recipient_id: admin?.userid || null,
                subject: subject || `Message from ${person?.full_name}`,
                body
            });

            if (error) throw error;
            return res.status(200).json({ success: true });
        }



        // ── DASHBOARD COMBINED (single call for fast load) ──
        if (action === 'get_dashboard') {
            const results = { overview: null, trends: null };

            // Run overview and trends in parallel
            const [overviewData, trendsData] = await Promise.all([
                (async () => {
                    if (!idStrings.length) return { merchants:0, approved:0, pending:0, closed:0, mtd:0, vol30:0, vol90:0, open_rmas:0 };
                    const { data: stats } = await supabase.from('merchant_stats_by_id').select('merchant_count,pending_count,closed_count,total_volume_sum,total_volume_90d_sum').in('agent_id', idStrings);
                    let approved=0, pending=0, closed=0, mtd=0, vol90=0;
                    (stats||[]).forEach(s => {
                        approved += parseInt(s.merchant_count||0);
                        pending  += parseInt(s.pending_count||0);
                        closed   += parseInt(s.closed_count||0);
                        mtd      += parseFloat(s.total_volume_sum||0);
                        vol90    += parseFloat(s.total_volume_90d_sum||0);
                    });
                    return { merchants: approved+pending, approved, pending, closed, mtd, vol30: mtd, vol90, open_rmas: 0 };
                })(),
                (async () => {
                    if (!idStrings.length) return { growth:0, stable:0, at_risk:0, no_data:0, chart:[] };
                    const { data: merchants } = await supabase
                        .from('merchants')
                        .select('volume_mtd, volume_30_day, volume_90_day, enrollment_date')
                        .in('agent_id', idStrings)
                        .eq('account_status', 'Approved');

                    let growth=0, stable=0, at_risk=0, no_data=0;
                    const monthBuckets = {};
                    for (let i=5; i>=0; i--) {
                        const d = new Date(); d.setMonth(d.getMonth()-i);
                        const key = d.toLocaleString('default',{month:'short',year:'2-digit'});
                        monthBuckets[key] = { month:key, enrolled:0 };
                    }
                    (merchants||[]).forEach(m => {
                        const mtd = parseFloat(m.volume_mtd||0);
                        const vol90 = parseFloat(m.volume_90_day||0);
                        const baseline = vol90/3;
                        if (mtd===0 && baseline===0) no_data++;
                        else if (baseline===0 || mtd > baseline*1.05) growth++;
                        else if (mtd < baseline*0.95) at_risk++;
                        else stable++;
                        if (m.enrollment_date) {
                            const d = new Date(m.enrollment_date);
                            const key = d.toLocaleString('default',{month:'short',year:'2-digit'});
                            if (monthBuckets[key]) monthBuckets[key].enrolled++;
                        }
                    });
                    return { growth, stable, at_risk, no_data, chart: Object.values(monthBuckets) };
                })()
            ]);

            // New enrollments this week
            const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0,0,0,0);
            const { data: newEnrolls, count: enrollCount } = await supabase
                .from('merchants')
                .select('id, merchant_id, dba_name, account_status, agent_id, enrollment_date', { count:'exact' })
                .in('agent_id', idStrings)
                .gte('enrollment_date', weekStart.toISOString())
                .order('enrollment_date', { ascending: false });

            // Get company names for agent IDs
            const agentIds = identifiers.map(i => i.agent_id).filter(Boolean);
            const { data: agentsData } = await supabase
                .from('agents')
                .select('id, company_id, companies:company_id(company_name)')
                .in('id', agentIds);

            const companiesMap = {};
            (agentsData||[]).forEach(a => {
                companiesMap[a.id] = a.companies?.company_name || 'Independent';
            });

            return res.status(200).json({
                success: true,
                partner: personData,
                overview: overviewData,
                trends: trendsData,
                identifiers,
                companies: companiesMap,
                new_enrollments: { data: newEnrolls||[], count: enrollCount||0 }
            });
        }

        // ── UPDATE PROFILE ─────────────────────────────────
        if (action === 'update_profile') {
            const { full_name, phone_number } = body;
            const updates = {};
            if (full_name) updates.full_name = full_name.trim();
            if (phone_number !== undefined) updates.phone_number = phone_number.trim();
            const { error } = await supabase.from('persons').update(updates).eq('id', partnerId);
            if (error) return res.status(400).json({ success: false, message: error.message });
            return res.status(200).json({ success: true });
        }

        // ── TREND OVERVIEW ─────────────────────────────────
        if (action === 'get_trends') {
            if (!idStrings.length) return res.status(200).json({ success: true, data: { growth: 0, stable: 0, at_risk: 0, no_data: 0, chart: [] } });

            const { data: merchants } = await supabase
                .from('merchants')
                .select('id, dba_name, account_status, volume_mtd, volume_30_day, volume_90_day, enrollment_date')
                .in('agent_id', idStrings)
                .eq('account_status', 'Approved');

            let growth = 0, stable = 0, at_risk = 0, no_data = 0;

            // Monthly buckets for chart (last 6 months)
            const monthBuckets = {};
            for (let i = 5; i >= 0; i--) {
                const d = new Date();
                d.setMonth(d.getMonth() - i);
                const key = d.toLocaleString('default', { month: 'short', year: '2-digit' });
                monthBuckets[key] = { month: key, enrolled: 0, volume: 0 };
            }

            (merchants || []).forEach(m => {
                const mtd = parseFloat(m.volume_mtd || 0);
                const vol90 = parseFloat(m.volume_90_day || 0);
                const baseline = vol90 / 3; // avg monthly from 90d

                if (mtd === 0 && baseline === 0) {
                    no_data++;
                } else if (baseline === 0 || mtd > baseline * 1.05) {
                    growth++;
                } else if (mtd < baseline * 0.95) {
                    at_risk++;
                } else {
                    stable++;
                }

                // Enrollment chart buckets
                if (m.enrollment_date) {
                    const d = new Date(m.enrollment_date);
                    const key = d.toLocaleString('default', { month: 'short', year: '2-digit' });
                    if (monthBuckets[key]) {
                        monthBuckets[key].enrolled++;
                        monthBuckets[key].volume += mtd;
                    }
                }
            });

            return res.status(200).json({
                success: true,
                data: {
                    growth, stable, at_risk, no_data,
                    total: (merchants || []).length,
                    chart: Object.values(monthBuckets)
                }
            });
        }

        // ── NEW ENROLLMENTS ────────────────────────────────
        if (action === 'get_new_enrollments') {
            const { start_date, end_date } = req.body;
            if (!idStrings.length) return res.status(200).json({ success: true, data: [], count: 0 });

            // Default to this week if no dates provided
            const now = new Date();
            const weekStart = new Date(now);
            weekStart.setDate(now.getDate() - now.getDay()); // Sunday
            weekStart.setHours(0, 0, 0, 0);

            const fromDate = start_date || weekStart.toISOString();
            const toDate = end_date || now.toISOString();

            const { data, count, error } = await supabase
                .from('merchants')
                .select('id, merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_mtd, volume_30_day', { count: 'exact' })
                .in('agent_id', idStrings)
                .gte('enrollment_date', fromDate)
                .lte('enrollment_date', toDate)
                .order('enrollment_date', { ascending: false });

            if (error) throw error;

            const enriched = (data || []).map(m => {
                const id = identifiers.find(i => i.id_string === m.agent_id);
                return { ...m, rev_share: id?.rev_share || null };
            });

            return res.status(200).json({ success: true, data: enriched, count: count || 0 });
        }

        // ── GET ACTIVE DEPLOYMENTS FOR MERCHANT ───────────
        if (action === 'get_active_deployments') {
            const { merchant_uuid } = req.body;

            // Verify ownership
            const { data: merchant } = await supabase
                .from('merchants')
                .select('agent_id, dba_name, merchant_id')
                .eq('id', merchant_uuid)
                .single();

            if (!merchant || !idStrings.includes(merchant.agent_id)) {
                return res.status(403).json({ success: false, message: 'Access denied.' });
            }

            const { data: deployments } = await supabase
                .from('deployments')
                .select('id, status, created_at, equipments:equipment_id(serial_number, terminal_type)')
                .eq('merchant_id', merchant_uuid)
                .neq('status', 'Closed')
                .order('created_at', { ascending: false });

            return res.status(200).json({
                success: true,
                merchant: { id: merchant_uuid, dba_name: merchant.dba_name, merchant_id: merchant.merchant_id },
                deployments: deployments || []
            });
        }

        // ── EXPORT CSV ─────────────────────────────────────
        if (action === 'export_csv') {
            if (!idStrings.length) return res.status(200).json({ success: true, data: [] });

            const { data } = await supabase.from('merchants')
                .select('merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_30_day, volume_90_day, volume_mtd, email, merchant_phone')
                .in('agent_id', idStrings)
                .order('dba_name');

            return res.status(200).json({ success: true, data: data || [] });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });

    } catch (err) {
        console.error('Partner Data Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
