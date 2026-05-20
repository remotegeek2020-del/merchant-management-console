import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, reportType, startDate, endDate, subFilter, offset = 0, limit = 100 } = req.body;

    try {
        if (action === 'getMonthlyReport') {

            // ── INVENTORY ──────────────────────────────────
            if (reportType === 'inventory') {
                // Skip merchants join — equipments has two duplicate FKs to merchants
                // which causes PostgREST ambiguity. current_location already holds
                // the merchant name for deployed units.
                let query = supabase.from('equipments')
                    .select(`serial_number, terminal_type, status, current_location, received_date`, { count: 'exact' });

                if (subFilter) query = query.eq('current_location', subFilter);
                if (startDate) query = query.gte('received_date', startDate);
                if (endDate) query = query.lte('received_date', endDate);

                const { data, count, error } = await query.range(offset, offset + limit - 1).order('received_date', { ascending: false });
                if (error) throw error;

                const rawData = (data||[]).map(d => ({
                    'Serial Number': d.serial_number || '—',
                    'Terminal Type': d.terminal_type || '—',
                    'Status': d.status || '—',
                    'Location / Merchant': d.current_location || '—',
                    'Received Date': d.received_date ? new Date(d.received_date).toLocaleDateString() : '—',
                }));

                return res.status(200).json({ success: true, rawData, totalCount: count });
            }

            // ── DEPLOYMENTS ───────────────────────────────
            if (reportType === 'deployments') {
                const { data, count, error } = await supabase.from('deployments')
                    .select(`deployment_id, tid, status, purchase_type, tracking_id, target_deployment_date, merchant_received_date, created_at, is_bulk,
                        merchants!deployments_merchant_id_fkey(dba_name, merchant_id),
                        equipments!deployments_equipment_id_fkey(serial_number, terminal_type),
                        deployment_items(equipment_id, tid, equip:equipment_id(serial_number, terminal_type))`,
                        { count: 'exact' })
                    .gte('target_deployment_date', startDate)
                    .lte('target_deployment_date', endDate)
                    .order('target_deployment_date', { ascending: false })
                    .range(offset, offset + limit - 1);

                if (error) throw error;

                const fmt = d => d ? (String(d).match(/^\d{4}-\d{2}-\d{2}$/) ? d : new Date(d).toLocaleDateString()) : '—';

                const rawData = [];
                for (const d of (data || [])) {
                    const base = {
                        'Deployment ID':     d.deployment_id || '—',
                        'DBA Name':          d.merchants?.dba_name || '—',
                        'Merchant ID':       d.merchants?.merchant_id || '—',
                        'Purchase Type':     d.purchase_type || '—',
                        'Status':            d.status || '—',
                        'Tracking ID':       d.tracking_id || '—',
                        'Deployment Date':   fmt(d.target_deployment_date),
                        'Merchant Received': fmt(d.merchant_received_date),
                        'Created':           fmt(d.created_at),
                    };
                    if (d.is_bulk && d.deployment_items?.length > 0) {
                        // Expand: one row per unit
                        for (const item of d.deployment_items) {
                            rawData.push({ ...base,
                                'Serial Number': item.equip?.serial_number || '—',
                                'Terminal Type': item.equip?.terminal_type || '—',
                                'TID':           item.tid || '—',
                            });
                        }
                    } else {
                        rawData.push({ ...base,
                            'Serial Number': d.equipments?.serial_number || '—',
                            'Terminal Type': d.equipments?.terminal_type || '—',
                            'TID':           d.tid || '—',
                        });
                    }
                }

                return res.status(200).json({ success: true, rawData, totalCount: count });
            }

            // ── RETURNS ───────────────────────────────────
            if (reportType === 'returns') {
                const { data, count, error } = await supabase.from('returns')
                    .select(`return_id, return_reason, condition, status, destination, return_date_initiated, is_bulk,
                        merchants!returns_merchant_id_fkey(dba_name, merchant_id),
                        equipments!returns_equipment_id_fkey(serial_number, terminal_type),
                        deployments!returns_deployment_id_fkey(deployment_id),
                        return_items(equipment_id, condition, equip:equipment_id(serial_number, terminal_type))`,
                        { count: 'exact' })
                    .gte('return_date_initiated', startDate)
                    .lte('return_date_initiated', endDate)
                    .order('return_date_initiated', { ascending: false })
                    .range(offset, offset + limit - 1);

                if (error) throw error;

                const rawData = [];
                for (const d of (data || [])) {
                    const base = {
                        'RMA ID':            d.return_id || '—',
                        'Origin Deployment': d.deployments?.deployment_id || '—',
                        'Merchant':          d.merchants?.dba_name || '—',
                        'Merchant ID':       d.merchants?.merchant_id || '—',
                        'Reason':            d.return_reason || '—',
                        'Destination':       d.destination || '—',
                        'Status':            d.status || '—',
                        'Date Initiated':    d.return_date_initiated ? new Date(d.return_date_initiated).toLocaleDateString() : '—',
                    };
                    if (d.is_bulk && d.return_items?.length > 0) {
                        for (const item of d.return_items) {
                            // return_items.condition may still be 'IN TRANSIT' for older records;
                            // fall back to the parent return's condition which is always updated on close
                            const itemCondition = (item.condition && item.condition !== 'IN TRANSIT')
                                ? item.condition
                                : (d.condition || '—');
                            rawData.push({ ...base,
                                'Serial Number': item.equip?.serial_number || '—',
                                'Terminal Type': item.equip?.terminal_type || '—',
                                'Condition':     itemCondition,
                            });
                        }
                    } else {
                        rawData.push({ ...base,
                            'Serial Number': d.equipments?.serial_number || '—',
                            'Terminal Type': d.equipments?.terminal_type || '—',
                            'Condition':     d.condition || '—',
                        });
                    }
                }

                return res.status(200).json({ success: true, rawData, totalCount: count });
            }

            // ── MERCHANTS ─────────────────────────────────
            if (reportType === 'merchants') {
                let query = supabase.from('merchants')
                    .select(`merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_mtd, volume_30_day, volume_90_day, email, merchant_phone, merchant_city, merchant_state`, { count: 'exact' });

                if (subFilter) query = query.eq('account_status', subFilter);
                if (startDate) query = query.gte('enrollment_date', startDate);
                if (endDate) query = query.lte('enrollment_date', endDate);

                const { data, count, error } = await query
                    .order('enrollment_date', { ascending: false })
                    .range(offset, offset + limit - 1);

                if (error) throw error;

                const rawData = (data||[]).map(d => ({
                    'Merchant ID': d.merchant_id || '—',
                    'DBA Name': d.dba_name || '—',
                    'Status': d.account_status || '—',
                    'Agent ID': d.agent_id || '—',
                    'Enrolled': d.enrollment_date ? new Date(d.enrollment_date).toLocaleDateString() : '—',
                    'MTD Volume': parseFloat(d.volume_mtd||0).toFixed(2),
                    '30D Volume': parseFloat(d.volume_30_day||0).toFixed(2),
                    '90D Volume': parseFloat(d.volume_90_day||0).toFixed(2),
                    'Email': d.email || '—',
                    'Phone': d.merchant_phone || '—',
                    'City': d.merchant_city || '—',
                    'State': d.merchant_state || '—'
                }));

                return res.status(200).json({ success: true, rawData, totalCount: count });
            }

            // ── PRIME49 ───────────────────────────────────
            if (reportType === 'prime49') {
                // Step 1: find agent UUIDs that have at least one prime49 identifier
                const { data: primeAgents } = await supabase
                    .from('agent_identifiers')
                    .select('agent_id')
                    .eq('prime49', true);

                const primeAgentUuids = [...new Set((primeAgents||[]).map(p => p.agent_id))];
                if (!primeAgentUuids.length) return res.status(200).json({ success: true, rawData: [], totalCount: 0 });

                // Step 2: fetch ALL identifiers for those agents (prime49 and non-prime49)
                const { data: allIds } = await supabase
                    .from('agent_identifiers')
                    .select('id_string, rev_share, prime49, agents:agent_id(agent_name, persons:parent_agent_id(full_name, email))')
                    .in('agent_id', primeAgentUuids);

                const allIdStrings = (allIds||[]).map(p => p.id_string);
                if (!allIdStrings.length) return res.status(200).json({ success: true, rawData: [], totalCount: 0 });

                // Step 3: find merchants under ANY of those id_strings
                let query = supabase.from('merchants')
                    .select(`merchant_id, dba_name, account_status, agent_id, enrollment_date, volume_mtd, volume_30_day, volume_90_day`, { count: 'exact' })
                    .in('agent_id', allIdStrings);

                if (startDate) query = query.gte('enrollment_date', startDate);
                if (endDate) query = query.lte('enrollment_date', endDate);

                const { data, count, error } = await query
                    .order('volume_30_day', { ascending: false })
                    .range(offset, offset + limit - 1);

                if (error) throw error;

                // Build lookup by id_string → identifier info
                const idMap = {};
                (allIds||[]).forEach(p => { idMap[p.id_string] = p; });

                const rawData = (data||[]).map(d => {
                    const pid = idMap[d.agent_id];
                    return {
                        'Merchant ID': d.merchant_id || '—',
                        'DBA Name': d.dba_name || '—',
                        'Status': d.account_status || '—',
                        'Prime49 Agent ID': d.agent_id || '—',
                        'Partner Name': pid?.agents?.persons?.full_name || '—',
                        'Partner Email': pid?.agents?.persons?.email || '—',
                        'Rev Share': pid?.rev_share || '—',
                        'Enrolled': d.enrollment_date ? new Date(d.enrollment_date).toLocaleDateString() : '—',
                        'MTD Volume': parseFloat(d.volume_mtd||0).toFixed(2),
                        '30D Volume': parseFloat(d.volume_30_day||0).toFixed(2),
                        '90D Volume': parseFloat(d.volume_90_day||0).toFixed(2)
                    };
                });

                return res.status(200).json({ success: true, rawData, totalCount: count });
            }

            // ── PARTNERS ──────────────────────────────────
            if (reportType === 'partners') {
                let query = supabase.from('persons')
                    .select(`id, full_name, email, phone_number, enrolled_at, is_portal_active, last_portal_login`, { count: 'exact' });

                if (startDate) query = query.gte('enrolled_at', startDate);
                if (endDate) query = query.lte('enrolled_at', endDate + 'T23:59:59');

                const { data: persons, count } = await query.order('enrolled_at', { ascending: false }).range(offset, offset + limit - 1);

                // Get agent ID counts per person
                const personIds = (persons||[]).map(p => p.id);
                const { data: agents } = await supabase.from('agents').select('id, parent_agent_id').in('parent_agent_id', personIds);
                const agentIds = (agents||[]).map(a => a.id);
                const { data: identifiers } = await supabase.from('agent_identifiers').select('agent_id, id_string').in('agent_id', agentIds);

                // Build maps
                const agentsByPerson = {};
                (agents||[]).forEach(a => { if(!agentsByPerson[a.parent_agent_id]) agentsByPerson[a.parent_agent_id]=[];  agentsByPerson[a.parent_agent_id].push(a.id); });
                const idsByAgent = {};
                (identifiers||[]).forEach(i => { if(!idsByAgent[i.agent_id]) idsByAgent[i.agent_id]=[]; idsByAgent[i.agent_id].push(i.id_string); });

                const rawData = (persons||[]).map(p => {
                    const myAgents = agentsByPerson[p.id] || [];
                    const myIds = myAgents.flatMap(aid => idsByAgent[aid] || []);
                    return {
                        'Full Name': p.full_name || '—',
                        'Email': p.email || '—',
                        'Phone': p.phone_number || '—',
                        'Agent IDs': myIds.join(', ') || '—',
                        'ID Count': myIds.length,
                        'Enrolled': p.enrolled_at ? new Date(p.enrolled_at).toLocaleDateString() : '—',
                        'Portal Access': p.is_portal_active ? 'Yes' : 'No',
                        'Last Portal Login': p.last_portal_login ? new Date(p.last_portal_login).toLocaleDateString() : 'Never'
                    };
                });

                return res.status(200).json({ success: true, rawData, totalCount: count });
            }

            return res.status(400).json({ success: false, message: `Unknown report type: ${reportType}` });
        }

        if (action === 'get_cohort_retention') {
            // Fetch all merchants with an enrollment_date
            const { data: merchants, error: mErr } = await supabase
                .from('merchants')
                .select('merchant_id, enrollment_date, account_status, last_batch_date')
                .not('enrollment_date', 'is', null);

            if (mErr) throw mErr;

            const now = new Date();

            // Helper: months difference between two dates (floor)
            function monthsDiff(from, to) {
                return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
            }

            // Group merchants by cohort month (YYYY-MM of enrollment_date)
            const cohortMap = {};
            for (const m of (merchants || [])) {
                const enrolled = new Date(m.enrollment_date);
                if (isNaN(enrolled.getTime())) continue;
                const cohortKey = `${enrolled.getFullYear()}-${String(enrolled.getMonth() + 1).padStart(2, '0')}`;
                if (!cohortMap[cohortKey]) cohortMap[cohortKey] = [];
                cohortMap[cohortKey].push({ ...m, enrolledDate: enrolled });
            }

            // Build sorted list of cohort keys, limit to last 24
            const allCohorts = Object.keys(cohortMap).sort();
            const last24 = allCohorts.slice(-24);

            const result = last24.map(cohort => {
                const members = cohortMap[cohort];
                const size = members.length;
                const cohortDate = new Date(cohort + '-01');
                const ageMonths = monthsDiff(cohortDate, now);

                function retentionPct(minAge) {
                    if (ageMonths < minAge) return null; // cohort not old enough
                    const retained = members.filter(m => m.account_status === 'Approved').length;
                    return size > 0 ? Math.round((retained / size) * 100) : 0;
                }

                return {
                    cohort,
                    size,
                    ret_1:  retentionPct(1),
                    ret_3:  retentionPct(3),
                    ret_6:  retentionPct(6),
                    ret_12: retentionPct(12),
                };
            });

            return res.status(200).json({ success: true, data: result });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('Reports API Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
