import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function validateSession(token) {
    if (!token) return null;
    const { data, error } = await supabase.from('partner_sessions').select('person_id, expires_at').eq('session_token', token).single();
    if (error) return 'db_error'; // transient DB issue — do not treat as session expiry
    if (!data || new Date(data.expires_at) < new Date()) return null;
    return data.person_id;
}

async function getAgentIds(personId) {
    const { data: agents } = await supabase.from('agents').select('id, company_id, companies:company_id(company_name)').eq('parent_agent_id', personId);
    if (!agents?.length) return { agentUuids: [], idStrings: [], identifiers: [], companiesMap: {} };
    const agentUuids = agents.map(a => a.id);
    const { data: identifiers } = await supabase.from('agent_identifiers').select('id, agent_id, id_string, rev_share, prime49').in('agent_id', agentUuids);
    
    // Build companies map: agent_id -> company_name
    const companiesMap = {};
    agents.forEach(a => { companiesMap[a.id] = a.companies?.company_name || 'Independent'; });
    
    return { agentUuids, idStrings: (identifiers || []).map(i => i.id_string), identifiers: identifiers || [], companiesMap };
}

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, token } = req.body || {};
    const personId = await validateSession(token);
    if (personId === 'db_error') return res.status(503).json({ success: false, message: 'Service temporarily unavailable. Please try again.' });
    if (!personId) return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });

    const { agentUuids, idStrings, identifiers, companiesMap } = await getAgentIds(personId);

    try {

        // ── MY RANK ────────────────────────────────────────
        if (action === 'get_my_rank') {
            const { data, error } = await supabase.rpc('get_partner_rank', { p_person_id: personId });
            if (error || !data || !data.length) return res.status(200).json({ success: true, rank: null });
            const r = data[0];
            return res.status(200).json({ success: true, rank: Number(r.rank), total: Number(r.total), tier: r.tier, volume_30_day: parseFloat(r.volume_30_day) || 0 });
        }

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

            // Open RMAs for this partner (two-step: get merchant IDs first, then filter returns)
            const { data: partnerMerchants } = await supabase.from('merchants').select('id').in('agent_id', idStrings);
            const merchantIds = (partnerMerchants || []).map(m => m.id);
            const { count: openRmas } = merchantIds.length
                ? await supabase.from('returns').select('*', { count: 'exact', head: true }).in('merchant_id', merchantIds).eq('status', 'Open')
                : { count: 0 };

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

            const VALID_SORT = ['dba_name', 'volume_30_day', 'volume_mtd', 'enrollment_date', 'account_status'];
            const sortField = VALID_SORT.includes(req.body.sort_by) ? req.body.sort_by : 'dba_name';
            const sortAsc = req.body.sort_dir !== 'desc';
            const { data, count, error } = await query.range(page * limit, (page + 1) * limit - 1).order(sortField, { ascending: sortAsc, nullsFirst: false });
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

            // Legacy equipment (active only)
            const { data: legacyEquipment } = await supabase.from('legacy_deployments').select('id, serial_number, terminal_type, tid, deployment_date, status').eq('merchant_id', merchant_uuid).eq('status', 'active');

            // Notes
            const { data: notes } = await supabase.from('merchant_notes').select('id, title, body, created_at, created_by').eq('merchant_id', merchant_uuid).order('created_at', { ascending: false });

            // RMAs
            const { data: rmas } = await supabase.from('returns').select('id, return_id, return_reason, condition, status, destination, created_at, equipments:equipment_id(serial_number, terminal_type)').eq('merchant_id', merchant_uuid).order('created_at', { ascending: false });

            return res.status(200).json({ success: true, data: { merchant, equipment: equipment || [], legacyEquipment: legacyEquipment || [], notes: notes || [], rmas: rmas || [] } });
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

            // Fetch person info for profile
            const { data: personData } = await supabase
                .from('persons')
                .select('id, full_name, email, phone_number, is_portal_active, enrolled_at, last_portal_login, portal_password_set')
                .eq('id', personId)
                .single();

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
            let newEnrolls = [], neOffset = 0, neDone = false;
            while (!neDone) {
                const { data: neBatch } = await supabase
                    .from('merchants')
                    .select('id, merchant_id, dba_name, account_status, agent_id, enrollment_date')
                    .in('agent_id', idStrings)
                    .gte('enrollment_date', weekStart.toISOString())
                    .order('enrollment_date', { ascending: false })
                    .range(neOffset, neOffset + 999);
                if (!neBatch || neBatch.length === 0) { neDone = true; }
                else { newEnrolls = newEnrolls.concat(neBatch); neOffset += 1000; if (neBatch.length < 1000) neDone = true; }
            }

            return res.status(200).json({
                success: true,
                partner: personData,
                overview: overviewData,
                trends: trendsData,
                identifiers,
                companies: companiesMap,
                new_enrollments: { data: newEnrolls, count: newEnrolls.length }
            });
        }

        // ── UPDATE PROFILE ─────────────────────────────────
        if (action === 'update_profile') {
            const { full_name, phone_number } = req.body;
            const updates = {};
            if (full_name) updates.full_name = full_name.trim();
            if (phone_number !== undefined) updates.phone_number = phone_number.trim();
            const { error } = await supabase.from('persons').update(updates).eq('id', personId);
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

            let allData = [], offset = 0, done = false;
            while (!done) {
                const { data: batch, error } = await supabase
                    .from('merchants')
                    .select('id, merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_mtd, volume_30_day')
                    .in('agent_id', idStrings)
                    .gte('enrollment_date', fromDate)
                    .lte('enrollment_date', toDate)
                    .order('enrollment_date', { ascending: false })
                    .range(offset, offset + 999);
                if (error) throw error;
                if (!batch || batch.length === 0) { done = true; }
                else { allData = allData.concat(batch); offset += 1000; if (batch.length < 1000) done = true; }
            }

            const enriched = allData.map(m => {
                const id = identifiers.find(i => i.id_string === m.agent_id);
                return { ...m, rev_share: id?.rev_share || null };
            });

            return res.status(200).json({ success: true, data: enriched, count: enriched.length });
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

        // ── PORTFOLIO STATS ────────────────────────────────
        if (action === 'get_portfolio_stats') {
            if (!idStrings.length) return res.status(200).json({ success: true, trends: { growth:0, stable:0, at_risk:0, no_data:0 }, statuses: {}, top10: [] });

            const { data: merchants } = await supabase
                .from('merchants')
                .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, volume_mtd')
                .in('agent_id', idStrings);

            let growth = 0, stable = 0, at_risk = 0, no_data = 0;
            const statuses = {};
            const approvedWithVol = [];

            (merchants || []).forEach(m => {
                const st = m.account_status || 'Unknown';
                statuses[st] = (statuses[st] || 0) + 1;
                if (m.account_status !== 'Approved') return;
                const mtd = parseFloat(m.volume_30_day || 0);
                const baseline = parseFloat(m.volume_90_day || 0) / 3;
                let trend;
                if (mtd === 0 && baseline === 0) { no_data++; trend = 'no_data'; }
                else if (baseline === 0 || mtd > baseline * 1.05) { growth++; trend = 'growth'; }
                else if (mtd < baseline * 0.95) { at_risk++; trend = 'at_risk'; }
                else { stable++; trend = 'stable'; }
                approvedWithVol.push({ merchant_id: m.merchant_id, dba_name: m.dba_name, vol30: parseFloat(m.volume_30_day || 0), trend });
            });

            const top10 = approvedWithVol.filter(m => m.vol30 > 0).sort((a, b) => b.vol30 - a.vol30).slice(0, 10);
            return res.status(200).json({ success: true, trends: { growth, stable, at_risk, no_data }, statuses, top10 });
        }

        // ── BULK EMAIL AT-RISK ─────────────────────────────
        if (action === 'bulk_email_atrisk') {
            if (!idStrings.length) return res.status(200).json({ success: true, sent: 0, skipped: 0 });

            const { data: merchants } = await supabase
                .from('merchants')
                .select('merchant_id, dba_name, email, volume_30_day, volume_90_day, volume_mtd, account_status')
                .in('agent_id', idStrings)
                .eq('account_status', 'Approved');

            const atRisk = (merchants || []).filter(m => {
                const mtd = parseFloat(m.volume_30_day || 0);
                const baseline = parseFloat(m.volume_90_day || 0) / 3;
                return !(mtd === 0 && baseline === 0) && mtd < baseline * 0.95;
            });

            if (!atRisk.length) return res.status(200).json({ success: true, sent: 0, skipped: 0, total_at_risk: 0 });

            const { data: conns } = await supabase.from('partner_email_connections').select('*').eq('person_id', personId);
            if (!conns || !conns.length) return res.status(400).json({ success: false, message: 'No email connected. Please connect an email in Settings first.' });
            const conn = conns[0];

            const { data: partnerPerson } = await supabase.from('persons').select('full_name, email').eq('id', personId).single();
            const partnerName = partnerPerson?.full_name || 'Your Partner Representative';
            const partnerEmail = conn.email;

            const { getValidAccessToken, sendViaGoogle, sendViaMicrosoft } = await import('./partner-oauth.js');
            const accessToken = await getValidAccessToken(personId, conn.provider);
            if (!accessToken) return res.status(401).json({ success: false, message: 'Your email connection expired. Please reconnect in Settings.' });

            let sent = 0, skipped = 0, failed = 0;
            for (const merchant of atRisk) {
                if (!merchant.email) { skipped++; continue; }
                const vol30 = parseFloat(merchant.volume_30_day || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
                const vol90 = parseFloat(merchant.volume_90_day || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
                const subject = `A Quick Note About Your Account — ${merchant.dba_name}`;
                const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;border:1px solid #e2e8f0;border-radius:16px;">
                    <h2 style="color:#002d5a;margin-bottom:4px;">Checking In</h2>
                    <p style="color:#64748b;font-size:13px;margin-top:0;">Hello ${merchant.dba_name},</p>
                    <p style="color:#475569;line-height:1.6;">I hope everything is going well! I noticed some changes in your recent processing activity and wanted to reach out personally.</p>
                    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:16px 20px;margin:20px 0;">
                        <p style="color:#92400e;font-weight:700;margin:0 0 6px;">Recent Activity</p>
                        <p style="color:#9a3412;font-size:13px;margin:0;">30-Day Volume: <strong>${vol30}</strong> &nbsp;|&nbsp; 90-Day Volume: <strong>${vol90}</strong></p>
                    </div>
                    <p style="color:#475569;line-height:1.6;">I want to make sure you have everything you need. I'm happy to schedule a quick call or answer any questions.</p>
                    <p style="color:#475569;line-height:1.6;margin-bottom:4px;">Warm regards,</p>
                    <p style="color:#002d5a;font-weight:700;margin-top:0;">${partnerName}</p>
                    <p style="color:#64748b;font-size:12px;margin-top:4px;">${partnerEmail}</p>
                    <hr style="border:0;border-top:1px solid #f1f5f9;margin:24px 0;">
                    <p style="font-size:11px;color:#94a3b8;text-align:center;">This message was sent on behalf of your PayProTec partner representative.</p>
                </div>`;
                try {
                    const result = conn.provider === 'google'
                        ? await sendViaGoogle(accessToken, { to: merchant.email, subject, html, from: `${partnerName} <${partnerEmail}>` })
                        : await sendViaMicrosoft(accessToken, { to: merchant.email, subject, html });
                    if (result.error) failed++; else sent++;
                } catch(e) { failed++; }
            }
            return res.status(200).json({ success: true, sent, skipped, failed, total_at_risk: atRisk.length });
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

        // ── COMMUNITY FEED ─────────────────────────────────
        if (action === 'get_feed') {
            const { page = 0, author_only = false, category = null } = req.body;
            const limit = 20;
            let query = supabase
                .from('community_posts')
                .select('*')
                .eq('is_deleted', false)
                .order('is_pinned', { ascending: false })
                .order('created_at', { ascending: false })
                .range(page * limit, (page + 1) * limit - 1);
            if (author_only) query = query.eq('author_id', personId);
            if (category) query = query.eq('category', category);
            const { data: posts } = await query;

            // Get likes for current user
            const postIds = (posts || []).map(p => p.id);
            const { data: myLikes } = postIds.length ? await supabase
                .from('post_likes').select('post_id').eq('author_id', personId).in('post_id', postIds)
                : { data: [] };
            const likedSet = new Set((myLikes || []).map(l => l.post_id));

            return res.status(200).json({
                success: true,
                data: (posts || []).map(p => ({ ...p, liked_by_me: likedSet.has(p.id) }))
            });
        }

        if (action === 'create_post') {
            const { body: postBody, media_urls, media_types, post_type, category } = req.body;
            if (!postBody && (!media_urls || !media_urls.length)) {
                return res.status(400).json({ success: false, message: 'Post cannot be empty.' });
            }
            const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).single();
            const authorName = person?.full_name || 'Partner';
            const { data, error } = await supabase.from('community_posts').insert({
                author_id: personId,
                author_type: 'partner',
                author_name: authorName,
                body: postBody || '',
                media_urls: media_urls || [],
                media_types: media_types || [],
                post_type: post_type || 'text',
                category: category || 'general'
            }).select().single();
            if (error) return res.status(400).json({ success: false, message: error.message });
            return res.status(200).json({ success: true, data: { ...data, author_name: authorName } });
        }

        if (action === 'delete_post') {
            const { post_id } = req.body;
            const { data: post } = await supabase.from('community_posts').select('author_id').eq('id', post_id).single();
            if (!post || post.author_id !== personId) return res.status(403).json({ success: false, message: 'Not authorized.' });
            await supabase.from('community_posts').delete().eq('id', post_id);
            return res.status(200).json({ success: true });
        }

        if (action === 'toggle_like') {
            const { post_id } = req.body;
            const { data: existing } = await supabase.from('post_likes').select('id').eq('post_id', post_id).eq('author_id', personId).maybeSingle();
            const { data: post } = await supabase.from('community_posts').select('likes_count').eq('id', post_id).single();
            const currentCount = post?.likes_count || 0;
            if (existing) {
                await supabase.from('post_likes').delete().eq('id', existing.id);
                await supabase.from('community_posts').update({ likes_count: Math.max(0, currentCount - 1) }).eq('id', post_id);
                return res.status(200).json({ success: true, liked: false, count: Math.max(0, currentCount - 1) });
            } else {
                await supabase.from('post_likes').insert({ post_id, author_id: personId });
                await supabase.from('community_posts').update({ likes_count: currentCount + 1 }).eq('id', post_id);
                return res.status(200).json({ success: true, liked: true, count: currentCount + 1 });
            }
        }

        if (action === 'get_comments') {
            const { post_id } = req.body;
            const { data } = await supabase.from('post_comments').select('*').eq('post_id', post_id).order('created_at', { ascending: true });
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'add_comment') {
            const { post_id, body: commentBody } = req.body;
            if (!commentBody?.trim()) return res.status(400).json({ success: false, message: 'Comment cannot be empty.' });
            const { data: person } = await supabase.from('persons').select('full_name').eq('id', personId).single();
            const { data, error } = await supabase.from('post_comments').insert({
                post_id, author_id: personId,
                author_name: person?.full_name || 'Partner',
                body: commentBody.trim()
            }).select().single();
            if (error) return res.status(400).json({ success: false, message: error.message });
            const { data: postForCount } = await supabase.from('community_posts').select('comments_count').eq('id', post_id).single();
            await supabase.from('community_posts').update({ comments_count: (postForCount?.comments_count || 0) + 1 }).eq('id', post_id);
            return res.status(200).json({ success: true, data });
        }

        if (action === 'upload_media') {
            const { file_base64, file_name, content_type } = req.body;
            if (!file_base64) return res.status(400).json({ success: false, message: 'No file provided.' });
            const buffer = Buffer.from(file_base64, 'base64');
            const path = personId + '/' + Date.now() + '_' + file_name;
            const { error } = await supabase.storage.from('partner-media').upload(path, buffer, { contentType: content_type, upsert: true });
            if (error) return res.status(400).json({ success: false, message: error.message });
            const { data: urlData } = supabase.storage.from('partner-media').getPublicUrl(path);
            return res.status(200).json({ success: true, url: urlData.publicUrl, type: content_type.startsWith('video') ? 'video' : 'image' });
        }

        if (action === 'get_notifications') {
            const { data } = await supabase
                .from('notifications')
                .select('id, type, title, body, actor_name, is_read, created_at, link')
                .eq('recipient_type', 'partner')
                .eq('recipient_id', String(personId))
                .order('created_at', { ascending: false })
                .limit(50);
            const unread = (data || []).filter(n => !n.is_read).length;
            return res.status(200).json({ success: true, notifications: data || [], unread });
        }

        if (action === 'mark_notifications_read') {
            await supabase.from('notifications')
                .update({ is_read: true })
                .eq('recipient_type', 'partner')
                .eq('recipient_id', String(personId))
                .eq('is_read', false);
            return res.status(200).json({ success: true });
        }

        // ── SUB-PARTNER ACTIONS ───────────────────────────────────────────────

        if (action === 'get_sub_partners') {
            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
            if (!myAgents || !myAgents.length) return res.status(200).json({ success: true, data: [] });
            const myAgentIds = myAgents.map(a => a.id);

            const { data: myIdentifiers } = await supabase.from('agent_identifiers').select('id').in('agent_id', myAgentIds);
            if (!myIdentifiers || !myIdentifiers.length) return res.status(200).json({ success: true, data: [] });
            const myIdentifierIds = myIdentifiers.map(i => i.id);

            const { data: subIdentifiers } = await supabase
                .from('agent_identifiers').select('id, agent_id, id_string, rev_share')
                .in('parent_config_id', myIdentifierIds);
            if (!subIdentifiers || !subIdentifiers.length) return res.status(200).json({ success: true, data: [] });

            const subAgentIds = [...new Set(subIdentifiers.map(i => i.agent_id))];
            const { data: subAgents } = await supabase.from('agents').select('id, parent_agent_id').in('id', subAgentIds);
            if (!subAgents || !subAgents.length) return res.status(200).json({ success: true, data: [] });
            const subPersonIds = [...new Set(subAgents.filter(a => a.parent_agent_id).map(a => a.parent_agent_id))];

            const { data: subPersons } = await supabase.from('persons')
                .select('id, full_name, email, is_portal_active').in('id', subPersonIds);
            if (!subPersons || !subPersons.length) return res.status(200).json({ success: true, data: [] });

            const agentToPersonMap = {};
            subAgents.forEach(a => { agentToPersonMap[a.id] = a.parent_agent_id; });

            const personIdentMap = {};
            subIdentifiers.forEach(si => {
                const pid = agentToPersonMap[si.agent_id];
                if (!pid) return;
                if (!personIdentMap[pid]) personIdentMap[pid] = [];
                personIdentMap[pid].push({ id: si.id, id_string: si.id_string, rev_share: si.rev_share });
            });

            const allSubIdStrings = subIdentifiers.map(i => i.id_string);
            let merchantRows = [];
            for (let i = 0; i < allSubIdStrings.length; i += 500) {
                const chunk = allSubIdStrings.slice(i, i + 500);
                const { data: mChunk } = await supabase.from('merchants').select('agent_id, volume_30_day').in('agent_id', chunk);
                if (mChunk) merchantRows = merchantRows.concat(mChunk);
            }

            const idStringToPersonId = {};
            subIdentifiers.forEach(si => { const pid = agentToPersonMap[si.agent_id]; if (pid) idStringToPersonId[si.id_string] = pid; });

            const personMerchStats = {};
            merchantRows.forEach(m => {
                const pid = idStringToPersonId[m.agent_id];
                if (!pid) return;
                if (!personMerchStats[pid]) personMerchStats[pid] = { merchant_count: 0, volume_30_day: 0 };
                personMerchStats[pid].merchant_count++;
                personMerchStats[pid].volume_30_day += parseFloat(m.volume_30_day || 0);
            });

            return res.status(200).json({ success: true, data: subPersons.map(p => ({
                person_id: p.id, full_name: p.full_name, email: p.email, is_portal_active: p.is_portal_active,
                agent_ids: personIdentMap[p.id] || [],
                merchant_count: personMerchStats[p.id]?.merchant_count || 0,
                volume_30_day: personMerchStats[p.id]?.volume_30_day || 0
            }))});
        }

        if (action === 'get_sub_partner_merchants') {
            const { sub_person_id } = req.body;
            if (!sub_person_id) return res.status(400).json({ success: false, message: 'sub_person_id required.' });

            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
            const myAgentIds = (myAgents || []).map(a => a.id);
            const { data: myIdentifiers } = await supabase.from('agent_identifiers').select('id').in('agent_id', myAgentIds.length ? myAgentIds : ['__none__']);
            const myIdentifierIds = (myIdentifiers || []).map(i => i.id);

            const { data: subAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', sub_person_id);
            if (!subAgents || !subAgents.length) return res.status(200).json({ success: true, data: [] });
            const { data: subIdentifiers } = await supabase.from('agent_identifiers')
                .select('id, id_string, parent_config_id').in('agent_id', subAgents.map(a => a.id));
            if (!subIdentifiers || !subIdentifiers.length) return res.status(200).json({ success: true, data: [] });

            const isSubPartner = subIdentifiers.some(si => myIdentifierIds.includes(si.parent_config_id));
            if (!isSubPartner) return res.status(403).json({ success: false, message: 'Access denied.' });

            let allMerchants = [];
            const subIdStrings = subIdentifiers.map(i => i.id_string);
            for (let i = 0; i < subIdStrings.length; i += 500) {
                const { data: mChunk } = await supabase.from('merchants')
                    .select('merchant_id, dba_name, account_status, volume_30_day, enrollment_date')
                    .in('agent_id', subIdStrings.slice(i, i + 500)).order('dba_name');
                if (mChunk) allMerchants = allMerchants.concat(mChunk);
            }
            return res.status(200).json({ success: true, data: allMerchants });
        }

        if (action === 'resolve_identifier_id') {
            const { id_string: lookupIdString } = req.body;
            if (!lookupIdString) return res.status(400).json({ success: false, message: 'id_string required.' });
            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
            const myAgentIds = (myAgents || []).map(a => a.id);
            const { data: ident } = await supabase.from('agent_identifiers').select('id')
                .eq('id_string', lookupIdString).in('agent_id', myAgentIds.length ? myAgentIds : ['__none__']).maybeSingle();
            if (!ident) return res.status(403).json({ success: false, message: 'Identifier not found or does not belong to you.' });
            return res.status(200).json({ success: true, identifier_id: ident.id });
        }

        if (action === 'invite_sub_partner') {
            const { email, full_name, agent_id_string, rev_share, parent_identifier_id, parent_id_string } = req.body;
            if (!email || !full_name || !agent_id_string || (!parent_identifier_id && !parent_id_string))
                return res.status(400).json({ success: false, message: 'email, full_name, agent_id_string, and a parent identifier are required.' });

            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
            const myAgentIds = (myAgents || []).map(a => a.id);

            let resolvedParentIdentId = parent_identifier_id;
            if (!resolvedParentIdentId && parent_id_string) {
                const { data: foundIdent } = await supabase.from('agent_identifiers').select('id')
                    .eq('id_string', parent_id_string).in('agent_id', myAgentIds.length ? myAgentIds : ['__none__']).maybeSingle();
                if (!foundIdent) return res.status(403).json({ success: false, message: 'Parent identifier not found or does not belong to you.' });
                resolvedParentIdentId = foundIdent.id;
            }

            const { data: parentIdent } = await supabase.from('agent_identifiers').select('id, agent_id').eq('id', resolvedParentIdentId).single();
            if (!parentIdent || !myAgentIds.includes(parentIdent.agent_id))
                return res.status(403).json({ success: false, message: 'Access denied: identifier does not belong to you.' });

            const { data: existingPerson } = await supabase.from('persons').select('id').eq('email', email.toLowerCase().trim()).maybeSingle();
            if (existingPerson) return res.status(400).json({ success: false, message: 'A partner with this email already exists.' });
            const { data: existingIdent } = await supabase.from('agent_identifiers').select('id').eq('id_string', agent_id_string.trim()).maybeSingle();
            if (existingIdent) return res.status(400).json({ success: false, message: 'This Agent ID string is already in use.' });

            const properName = full_name.trim().toLowerCase().split(' ').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
            const { data: newPerson, error: personErr } = await supabase.from('persons')
                .insert({ full_name: properName, email: email.toLowerCase().trim(), is_portal_active: true, enrolled_at: new Date().toISOString() })
                .select().single();
            if (personErr) return res.status(400).json({ success: false, message: 'Failed to create partner: ' + personErr.message });

            const { data: newAgent, error: agentErr } = await supabase.from('agents')
                .insert({ agent_name: properName, parent_agent_id: newPerson.id }).select().single();
            if (agentErr) return res.status(400).json({ success: false, message: 'Failed to create agent: ' + agentErr.message });

            const { error: identErr } = await supabase.from('agent_identifiers').insert({
                agent_id: newAgent.id, id_string: agent_id_string.trim(),
                rev_share: parseFloat(rev_share) || 0, parent_config_id: resolvedParentIdentId
            });
            if (identErr) return res.status(400).json({ success: false, message: 'Failed to create agent identifier: ' + identErr.message });

            try {
                await supabase.from('activity_logs').insert({
                    action: 'Invite Sub-Partner', category: 'partners',
                    email: 'system@portal', status: 'success',
                    new_value: JSON.stringify({ invited: email, by_person: personId })
                });
            } catch (e) { /* non-critical */ }

            return res.status(200).json({ success: true, person_id: newPerson.id });
        }

        if (action === 'update_sub_partner_rev_share') {
            const { identifier_id, rev_share } = req.body;
            if (!identifier_id || rev_share === undefined)
                return res.status(400).json({ success: false, message: 'identifier_id and rev_share are required.' });

            const { data: myAgents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
            const myAgentIds = (myAgents || []).map(a => a.id);
            const { data: myIdentifiers } = await supabase.from('agent_identifiers').select('id').in('agent_id', myAgentIds.length ? myAgentIds : ['__none__']);
            const myIdentifierIds = (myIdentifiers || []).map(i => i.id);

            const { data: targetIdent } = await supabase.from('agent_identifiers').select('id, parent_config_id').eq('id', identifier_id).single();
            if (!targetIdent || !myIdentifierIds.includes(targetIdent.parent_config_id))
                return res.status(403).json({ success: false, message: 'Access denied.' });

            const { error } = await supabase.from('agent_identifiers').update({ rev_share: parseFloat(rev_share) }).eq('id', identifier_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // ── MERCHANT EDIT (limited fields) ─────────────────
        if (action === 'update_merchant_contact') {
            const { merchant_id, merchant_primary_contact, merchant_phone, email, merchant_address, merchant_city, merchant_state, merchant_zip } = req.body;
            if (!merchant_id) return res.status(400).json({ success: false, message: 'merchant_id required.' });

            // Security: confirm merchant belongs to this partner
            const { data: m } = await supabase.from('merchants').select('id, agent_id').eq('merchant_id', merchant_id).single();
            if (!m) return res.status(404).json({ success: false, message: 'Merchant not found.' });
            if (!idStrings.includes(m.agent_id)) return res.status(403).json({ success: false, message: 'Access denied.' });

            const updates = {};
            if (merchant_primary_contact !== undefined) updates.merchant_primary_contact = merchant_primary_contact;
            if (merchant_phone !== undefined)           updates.merchant_phone = merchant_phone;
            if (email !== undefined)                   updates.email = email;
            if (merchant_address !== undefined)         updates.merchant_address = merchant_address;
            if (merchant_city !== undefined)            updates.merchant_city = merchant_city;
            if (merchant_state !== undefined)           updates.merchant_state = merchant_state;
            if (merchant_zip !== undefined)             updates.merchant_zip = merchant_zip;

            const { error } = await supabase.from('merchants').update(updates).eq('merchant_id', merchant_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // ── EMAIL CONNECTION STATUS ─────────────────────────
        if (action === 'get_email_connections') {
            const { data: conns } = await supabase
                .from('partner_email_connections')
                .select('provider, email, token_expiry, updated_at')
                .eq('person_id', personId);
            return res.status(200).json({ success: true, connections: conns || [] });
        }

        // ── OAUTH CONNECT URL ───────────────────────────────
        if (action === 'get_oauth_url') {
            const { provider } = req.body;
            const PORTAL_URL   = process.env.SITE_URL || 'https://portal.mypayprotec.com';
            const REDIRECT_URI = `${PORTAL_URL}/api/partner-oauth`;
            const { createHmac } = await import('crypto');
            const STATE_SECRET = process.env.TOKEN_ENCRYPTION_KEY || 'fallback-secret';
            const payload = { personId, provider, ts: Date.now() };
            const b64  = Buffer.from(JSON.stringify(payload)).toString('base64url');
            const sig  = createHmac('sha256', STATE_SECRET).update(b64).digest('hex').slice(0, 16);
            const state = `${b64}.${sig}`;

            let url;
            if (provider === 'google') {
                if (!process.env.GOOGLE_CLIENT_ID) return res.status(200).json({ success: false, message: 'Google OAuth not configured yet.' });
                url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
                    client_id:     process.env.GOOGLE_CLIENT_ID,
                    redirect_uri:  REDIRECT_URI,
                    response_type: 'code',
                    scope:         'https://www.googleapis.com/auth/gmail.send openid email',
                    access_type:   'offline',
                    prompt:        'consent',
                    state
                });
            } else if (provider === 'microsoft') {
                if (!process.env.MICROSOFT_CLIENT_ID) return res.status(200).json({ success: false, message: 'Microsoft OAuth not configured yet.' });
                const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
                url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?` + new URLSearchParams({
                    client_id:     process.env.MICROSOFT_CLIENT_ID,
                    redirect_uri:  REDIRECT_URI,
                    response_type: 'code',
                    scope:         'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access',
                    prompt:        'select_account',
                    state
                });
            } else {
                return res.status(400).json({ success: false, message: 'Unknown provider.' });
            }
            return res.status(200).json({ success: true, url });
        }

        // ── OAUTH DISCONNECT ────────────────────────────────
        if (action === 'disconnect_email') {
            const { provider } = req.body;
            await supabase.from('partner_email_connections').delete().eq('person_id', personId).eq('provider', provider);
            return res.status(200).json({ success: true });
        }

        // ── SEND MERCHANT REPORT EMAIL ──────────────────────
        if (action === 'send_merchant_email') {
            const { merchant_id, email_type } = req.body; // email_type: 'report' | 'atrisk'
            if (!merchant_id || !email_type) return res.status(400).json({ success: false, message: 'merchant_id and email_type required.' });

            // Security check
            const { data: merchant } = await supabase.from('merchants').select('*').eq('merchant_id', merchant_id).single();
            if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });
            if (!idStrings.includes(merchant.agent_id)) return res.status(403).json({ success: false, message: 'Access denied.' });
            if (!merchant.email) return res.status(400).json({ success: false, message: 'This merchant has no email on file.' });

            // Get partner's connected email
            const { data: conns } = await supabase.from('partner_email_connections').select('*').eq('person_id', personId);
            if (!conns || !conns.length) return res.status(400).json({ success: false, message: 'No email connected. Please connect an email in Settings first.' });
            const conn = conns[0];

            // Get partner name
            const { data: partnerPerson } = await supabase.from('persons').select('full_name, email').eq('id', personId).single();
            const partnerName = partnerPerson?.full_name || 'Your Partner Representative';
            const partnerEmail = conn.email;

            const { getValidAccessToken, sendViaGoogle, sendViaMicrosoft } = await import('./partner-oauth.js');
            const accessToken = await getValidAccessToken(personId, conn.provider);
            if (!accessToken) return res.status(401).json({ success: false, message: 'Your email connection expired and needs to be reconnected. Please go to Settings and connect your Gmail again.' });

            const vol30  = parseFloat(merchant.volume_30_day  || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
            const vol90  = parseFloat(merchant.volume_90_day  || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
            const volMTD = parseFloat(merchant.volume_mtd     || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

            let subject, html;

            if (email_type === 'report') {
                subject = `Your Account Update — ${merchant.dba_name}`;
                html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;border:1px solid #e2e8f0;border-radius:16px;">
                    <h2 style="color:#002d5a;margin-bottom:4px;">Account Summary</h2>
                    <p style="color:#64748b;font-size:13px;margin-top:0;">Hello ${merchant.merchant_primary_contact || merchant.dba_name},</p>
                    <p style="color:#475569;line-height:1.6;">I wanted to reach out with a quick update on your PayProTec merchant account. Here's a snapshot of your recent processing activity:</p>
                    <div style="background:#f8fafc;border-radius:12px;padding:20px;margin:20px 0;">
                        <table style="width:100%;border-collapse:collapse;font-size:13px;">
                            <tr><td style="padding:6px 0;color:#64748b;">Business Name</td><td style="text-align:right;font-weight:700;color:#002d5a;">${merchant.dba_name}</td></tr>
                            <tr><td style="padding:6px 0;color:#64748b;">Account Status</td><td style="text-align:right;font-weight:700;color:#059669;">${merchant.account_status}</td></tr>
                            <tr style="border-top:1px solid #e2e8f0;"><td style="padding:10px 0 6px;color:#64748b;">MTD Volume</td><td style="text-align:right;font-weight:700;color:#002d5a;">${volMTD}</td></tr>
                            <tr><td style="padding:6px 0;color:#64748b;">30-Day Volume</td><td style="text-align:right;font-weight:700;color:#002d5a;">${vol30}</td></tr>
                            <tr><td style="padding:6px 0;color:#64748b;">90-Day Volume</td><td style="text-align:right;font-weight:700;color:#002d5a;">${vol90}</td></tr>
                        </table>
                    </div>
                    <p style="color:#475569;line-height:1.6;">If you have any questions about your account or would like to discuss ways to grow your processing volume, I'm always here to help.</p>
                    <p style="color:#475569;line-height:1.6;margin-bottom:4px;">Best regards,</p>
                    <p style="color:#002d5a;font-weight:700;margin-top:0;">${partnerName}</p>
                    <p style="color:#64748b;font-size:12px;margin-top:4px;">${partnerEmail}</p>
                    <hr style="border:0;border-top:1px solid #f1f5f9;margin:24px 0;">
                    <p style="font-size:11px;color:#94a3b8;text-align:center;">This message was sent on behalf of your PayProTec partner representative.</p>
                </div>`;
            } else {
                subject = `A Quick Note About Your Account — ${merchant.dba_name}`;
                html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;border:1px solid #e2e8f0;border-radius:16px;">
                    <h2 style="color:#002d5a;margin-bottom:4px;">Checking In</h2>
                    <p style="color:#64748b;font-size:13px;margin-top:0;">Hello ${merchant.merchant_primary_contact || merchant.dba_name},</p>
                    <p style="color:#475569;line-height:1.6;">I hope everything is going well with your business! I wanted to reach out personally because I noticed some changes in your recent processing activity that I'd love to chat with you about.</p>
                    <p style="color:#475569;line-height:1.6;">Your recent volume has shifted a bit compared to your typical pattern, and I want to make sure everything is running smoothly on your end — whether that's equipment, support, or anything else we can help with.</p>
                    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:16px 20px;margin:20px 0;">
                        <p style="color:#92400e;font-weight:700;margin:0 0 6px;">📊 Recent Activity</p>
                        <p style="color:#9a3412;font-size:13px;margin:0;">30-Day Volume: <strong>${vol30}</strong> &nbsp;|&nbsp; 90-Day Volume: <strong>${vol90}</strong></p>
                    </div>
                    <p style="color:#475569;line-height:1.6;">There's no cause for alarm — I just want to make sure you have everything you need to keep things moving. I'm happy to schedule a quick call or answer any questions by email.</p>
                    <p style="color:#475569;line-height:1.6;margin-bottom:4px;">Warm regards,</p>
                    <p style="color:#002d5a;font-weight:700;margin-top:0;">${partnerName}</p>
                    <p style="color:#64748b;font-size:12px;margin-top:4px;">${partnerEmail}</p>
                    <hr style="border:0;border-top:1px solid #f1f5f9;margin:24px 0;">
                    <p style="font-size:11px;color:#94a3b8;text-align:center;">This message was sent on behalf of your PayProTec partner representative.</p>
                </div>`;
            }

            const result = conn.provider === 'google'
                ? await sendViaGoogle(accessToken, { to: merchant.email, subject, html, from: `${partnerName} <${partnerEmail}>` })
                : await sendViaMicrosoft(accessToken, { to: merchant.email, subject, html });

            if (result.error) return res.status(500).json({ success: false, message: result.error.message || 'Send failed.' });
            return res.status(200).json({ success: true, message: `Email sent to ${merchant.email}` });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });

    } catch (err) {
        console.error('Partner Data Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
