// ── PUBLIC PRIME 49 QUALIFICATION CHECK ──────────────────────────────────────
// Powers the two-path Prime 49 landing (/prime49). No auth — public.
//   • config: returns the rendering config (CTA destinations) for the landing.
//   • check:  a partner enters their Partner ID → we return whether it qualifies
//             (has merchants eligible for a Prime 49 upgrade).
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
}

async function getThreshold() {
    const { data } = await supabase.from('app_settings').select('value').eq('key', 'prime49_min_volume').maybeSingle();
    const n = Number(data && data.value);
    return Number.isFinite(n) && n > 0 ? n : 15000;
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const action = body?.action;

    try {
        if (action === 'config') {
            const { data } = await supabase.from('app_settings').select('value').eq('key', 'prime49_cta').maybeSingle();
            let cfg = {}; try { cfg = data && data.value ? JSON.parse(data.value) : {}; } catch { cfg = {}; }
            return res.status(200).json({ success: true, cta: cfg });
        }

        if (action === 'check') {
            const id = String(body.partner_id || '').trim();
            if (!id) return res.status(200).json({ success: false, message: 'Enter your Partner ID.' });
            // Does the ID exist at all?
            const { data: ident } = await supabase.from('agent_identifiers')
                .select('id').eq('id_string', id).maybeSingle();
            if (!ident) return res.status(200).json({ success: true, status: 'not_found' });

            const threshold = await getThreshold();
            const { data: chk } = await supabase.rpc('prime49_partner_check', { p_id: id, min_vol: threshold });
            const row = Array.isArray(chk) && chk[0] ? chk[0] : { qualifying: 0, total_vol: 0 };
            const qualifying = Number(row.qualifying) || 0;
            return res.status(200).json({
                success: true,
                status: qualifying > 0 ? 'qualified' : 'not_qualified',
                qualifying,
                total_vol: Math.round(Number(row.total_vol) || 0),
                threshold
            });
        }

        return res.status(200).json({ success: false, message: 'Unknown action' });
    } catch (e) {
        console.error('[prime49-check]', e.message);
        return res.status(200).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
}
