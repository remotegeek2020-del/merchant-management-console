import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

// ── TERMINAL TYPE ESTIMATOR ───────────────────────────────────────────────────
// Ordered most-specific → least-specific so longer prefixes match first
const SERIAL_PREFIX_MAP = [
    { prefix: '118816', type: 'Z8 Terminal' },
    { prefix: '118172', type: 'Z8 Terminal' },
    { prefix: '11811',  type: 'Z11 Terminal' },
    { prefix: '1179',   type: 'Z9' },
    { prefix: '1259',   type: 'Z9' },
    { prefix: '181241', type: 'VL550' },
    { prefix: '181251', type: 'VL550' },
    { prefix: '181244', type: 'VP550' },
    { prefix: '118214', type: 'Valor VL100' },
    { prefix: '167242', type: 'VL100 Pro' },
    { prefix: '167250', type: 'VL100 Pro' },
    { prefix: '125214', type: 'Valor VL110' },
    { prefix: '310',    type: 'Valor VL300' },
    { prefix: '3026',   type: 'Z6 - Pin Pad' },
    { prefix: '3023',   type: 'Z3 - Pin Pad' },
    { prefix: '686',    type: 'DuoPricer Labler' },
    { prefix: 'Q7A',    type: 'RCKT POS' },
    { prefix: 'PQB8',   type: 'VP800 Cradle' },
    { prefix: 'X5B',    type: 'VP800' },
    { prefix: 'XC5',    type: 'VP800' },
    { prefix: 'NEBB',   type: 'VP550c' },
    { prefix: 'NDB4',   type: 'VP550' },
    { prefix: 'P18A',   type: 'Dejavoo P18' },
    { prefix: 'P17B',   type: 'Dejavoo P17' },
    { prefix: 'P12B',   type: 'Dejavoo P12' },
    { prefix: 'P8',     type: 'Dejavoo P8' },
    { prefix: 'P5',     type: 'Dejavoo P5' },
    { prefix: 'P3',     type: 'Dejavoo P3' },
    { prefix: 'P1',     type: 'Dejavoo P1' },
];

function estimateTerminalType(serial) {
    if (!serial) return null;
    const s = serial.trim().toUpperCase();
    // QD series: WP...Q2..., WP...Q3..., WP...Q4...
    if (s.startsWith('WP')) {
        if (s.includes('Q4')) return 'QD4';
        if (s.includes('Q3')) return 'QD3';
        if (s.includes('Q2')) return 'QD2';
    }
    for (const { prefix, type } of SERIAL_PREFIX_MAP) {
        if (s.startsWith(prefix.toUpperCase())) return type;
    }
    return null;
}

// ── ACCESS CHECK ──────────────────────────────────────────────────────────────
async function hasAccess(supabase, userid) {
    if (!userid) return false;
    const { data } = await supabase.from('app_users')
        .select('role, is_active, access_deployments, access_merchants, access_returns')
        .eq('userid', userid).single();
    if (!data || !data.is_active) return false;
    return data.role === 'super_admin' || data.role === 'admin' ||
        data.access_deployments || data.access_merchants || data.access_returns;
}

async function isSuperAdmin(supabase, userid) {
    if (!userid) return false;
    const { data } = await supabase.from('app_users').select('role, is_active').eq('userid', userid).single();
    return data?.is_active === true && (data?.role === 'super_admin' || data?.role === 'admin');
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const body = req.body || {};
    const { action } = body;

    if (!action) return res.status(400).json({ success: false, message: 'No action provided' });

    const allowed = await hasAccess(supabase, session.userid);
    if (!allowed) return res.status(403).json({ success: false, message: 'Access denied.' });

    try {

        // ── LIST ──────────────────────────────────────────────────────────────
        if (action === 'list') {
            const { search, status, page = 1, limit = 50 } = body;
            const offset = (page - 1) * limit;

            let q = supabase.from('legacy_deployments')
                .select(`*, merchants:merchant_id(dba_name, merchant_id)`, { count: 'exact' });

            if (status && status !== 'all') q = q.eq('status', status);

            if (search) {
                const s = search.trim();
                // search serial, TID, MID, merchant name
                const { data: mIds } = await supabase.from('merchants')
                    .select('id').ilike('dba_name', `%${s}%`).limit(20);
                const mid_uuids = (mIds || []).map(m => m.id);
                let orParts = `serial_number.ilike.%${s}%,tid.ilike.%${s}%,mid.ilike.%${s}%`;
                if (mid_uuids.length) orParts += `,merchant_id.in.(${mid_uuids.join(',')})`;
                q = q.or(orParts);
            }

            const { data, count, error } = await q
                .order('deployment_date', { ascending: false })
                .range(offset, offset + limit - 1);
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [], total: count || 0 });
        }

        // ── GET BY MERCHANT ───────────────────────────────────────────────────
        if (action === 'get_by_merchant') {
            const { merchant_id } = body;
            if (!merchant_id) return res.status(400).json({ success: false, message: 'merchant_id required' });
            const { data, error } = await supabase.from('legacy_deployments')
                .select('*')
                .eq('merchant_id', merchant_id)
                .in('status', ['active', 'rma_filed'])
                .order('deployment_date', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        // ── STATS ─────────────────────────────────────────────────────────────
        if (action === 'stats') {
            const { data } = await supabase.from('legacy_deployments').select('status');
            const counts = { active: 0, rma_filed: 0, converted: 0, total: 0 };
            (data || []).forEach(r => {
                counts.total++;
                if (counts[r.status] !== undefined) counts[r.status]++;
            });
            return res.status(200).json({ success: true, counts });
        }

        // ── FILE RMA ──────────────────────────────────────────────────────────
        if (action === 'file_rma') {
            const { legacy_id, return_reason, notes: rmaNote } = body;
            if (!legacy_id) return res.status(400).json({ success: false, message: 'legacy_id required' });

            const { data: leg, error: legErr } = await supabase
                .from('legacy_deployments').select('*').eq('id', legacy_id).single();
            if (legErr || !leg) return res.status(404).json({ success: false, message: 'Legacy record not found' });
            if (leg.status !== 'active') return res.status(400).json({ success: false, message: 'RMA already filed for this record' });

            // Generate a return_id
            const { data: lastRet } = await supabase.from('returns')
                .select('return_id').order('created_at', { ascending: false }).limit(1).single();
            const lastNum = lastRet?.return_id ? parseInt(lastRet.return_id.replace(/\D/g, ''), 10) || 1000 : 1000;
            const return_id = `RMA-${String(lastNum + 1).padStart(5, '0')}`;

            const { data: newReturn, error: retErr } = await supabase.from('returns').insert({
                return_id,
                merchant_id: leg.merchant_id || null,
                equipment_id: null,
                deployment_id: null,
                legacy_deployment_id: legacy_id,
                return_reason: return_reason || 'Legacy Equipment Return',
                notes: rmaNote || null,
                return_date_initiated: new Date().toISOString(),
                status: 'Open',
                condition: 'IN TRANSIT',
                is_bulk: false
            }).select('id, return_id').single();
            if (retErr) throw retErr;

            // Update legacy record
            await supabase.from('legacy_deployments').update({
                status: 'rma_filed',
                return_id: newReturn.id
            }).eq('id', legacy_id);

            // Activity log
            const { data: actor } = await supabase.from('app_users').select('email, first_name, last_name').eq('userid', session.userid).maybeSingle();
            const actorName = actor ? `${actor.first_name || ''} ${actor.last_name || ''}`.trim() || actor.email : 'Staff';
            supabase.from('activity_logs').insert({
                email: actor?.email || session.userid,
                action: `Legacy RMA filed by ${actorName} — Serial: ${leg.serial_number}`,
                status: 'success', category: 'returns', severity: 'info',
                new_value: { return_id, serial_number: leg.serial_number, legacy_id }
            }).then(() => {}).catch(() => {});

            return res.status(200).json({ success: true, return_id: newReturn.return_id, id: newReturn.id });
        }

        // ── UPLOAD (import CSV rows) ───────────────────────────────────────────
        if (action === 'upload') {
            if (!(await isSuperAdmin(supabase, session.userid))) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const { rows } = body; // array of parsed CSV row objects
            if (!rows?.length) return res.status(400).json({ success: false, message: 'No rows provided' });

            // Build MID → merchant_id lookup
            const mids = [...new Set(rows.map(r => r.mid).filter(Boolean))];
            const { data: merchants } = await supabase.from('merchants')
                .select('id, merchant_id').in('merchant_id', mids);
            const midMap = {};
            (merchants || []).forEach(m => { midMap[m.merchant_id] = m.id; });

            // Check which serials already exist (skip duplicates)
            const serials = rows.map(r => r.serial_number).filter(Boolean);
            const { data: existing } = await supabase.from('legacy_deployments')
                .select('serial_number').in('serial_number', serials);
            const existingSerials = new Set((existing || []).map(e => e.serial_number));

            const toInsert = [];
            const skipped = [];

            for (const r of rows) {
                if (!r.serial_number) { skipped.push({ row: r, reason: 'Missing serial number' }); continue; }
                if (existingSerials.has(r.serial_number)) { skipped.push({ row: r, reason: 'Duplicate serial' }); continue; }

                // Determine terminal type
                let terminal_type = r.terminal_type?.trim() || null;
                let terminal_type_source = 'unknown';
                if (terminal_type) {
                    terminal_type_source = 'csv';
                } else {
                    const est = estimateTerminalType(r.serial_number);
                    if (est) { terminal_type = est; terminal_type_source = 'estimated'; }
                }

                toInsert.push({
                    deployment_date: r.deployment_date || null,
                    tid: r.tid || null,
                    serial_number: r.serial_number.trim(),
                    mid: r.mid || null,
                    merchant_id: r.mid ? (midMap[r.mid] || null) : null,
                    tracking_number: r.tracking_number || null,
                    notes: r.notes || null,
                    purchase_type: r.purchase_type || null,
                    terminal_type,
                    terminal_type_source,
                    status: 'active',
                    imported_by: session.userid
                });
            }

            let inserted = 0;
            if (toInsert.length) {
                const { error: insErr } = await supabase.from('legacy_deployments').insert(toInsert);
                if (insErr) throw insErr;
                inserted = toInsert.length;
            }

            return res.status(200).json({ success: true, inserted, skipped: skipped.length, skipped_details: skipped });
        }

        // ── PREVIEW (estimate without inserting) ──────────────────────────────
        if (action === 'preview') {
            const { rows } = body;
            if (!rows?.length) return res.status(400).json({ success: false, message: 'No rows provided' });

            const mids = [...new Set(rows.map(r => r.mid).filter(Boolean))];
            const { data: merchants } = await supabase.from('merchants')
                .select('id, merchant_id, dba_name').in('merchant_id', mids);
            const midMap = {};
            (merchants || []).forEach(m => { midMap[m.merchant_id] = { id: m.id, name: m.dba_name }; });

            const serials = rows.map(r => r.serial_number).filter(Boolean);
            const { data: existing } = await supabase.from('legacy_deployments')
                .select('serial_number').in('serial_number', serials);
            const existingSerials = new Set((existing || []).map(e => e.serial_number));

            const preview = rows.map(r => {
                const est = estimateTerminalType(r.serial_number);
                const csvType = r.terminal_type?.trim() || null;
                return {
                    ...r,
                    merchant_name: midMap[r.mid]?.name || null,
                    merchant_matched: !!midMap[r.mid],
                    terminal_type: csvType || est || null,
                    terminal_type_source: csvType ? 'csv' : (est ? 'estimated' : 'unknown'),
                    is_duplicate: existingSerials.has(r.serial_number)
                };
            });

            return res.status(200).json({ success: true, preview });
        }

        // ── UPDATE (manual correction of terminal type / merchant) ────────────
        if (action === 'update') {
            if (!(await isSuperAdmin(supabase, session.userid))) return res.status(403).json({ success: false, message: 'Super admin only.' });
            const { legacy_id, terminal_type, merchant_id } = body;
            if (!legacy_id) return res.status(400).json({ success: false, message: 'legacy_id required' });
            const updates = {};
            if (terminal_type !== undefined) { updates.terminal_type = terminal_type; updates.terminal_type_source = 'manual'; }
            if (merchant_id !== undefined) updates.merchant_id = merchant_id;
            const { error } = await supabase.from('legacy_deployments').update(updates).eq('id', legacy_id);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('[Legacy API Error]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
