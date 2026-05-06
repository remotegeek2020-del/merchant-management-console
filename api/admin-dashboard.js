import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body;

    try {
        if (action === 'get_kpis') {
            const weekStart = new Date();
            weekStart.setDate(weekStart.getDate() - weekStart.getDay());
            weekStart.setHours(0, 0, 0, 0);

            const [merchantStats, deploymentCount, openRmaCount, equipRows, newThisWeek, recentActivity] = await Promise.all([
                supabase.from('merchant_stats_by_id').select('merchant_count, pending_count, closed_count, total_volume_sum, total_volume_90d_sum'),
                supabase.from('deployments').select('*', { count: 'exact', head: true }).in('status', ['Open', 'In Transit']),
                supabase.from('returns').select('*', { count: 'exact', head: true }).eq('status', 'Open'),
                supabase.from('equipments').select('status, current_location'),
                supabase.from('merchants').select('*', { count: 'exact', head: true }).gte('enrollment_date', weekStart.toISOString()),
                supabase.from('activity_logs').select('email, action, status, created_at').order('created_at', { ascending: false }).limit(12)
            ]);

            let approved = 0, pending = 0, closed = 0, mtd = 0, vol90 = 0;
            (merchantStats.data || []).forEach(s => {
                approved += parseInt(s.merchant_count || 0);
                pending  += parseInt(s.pending_count || 0);
                closed   += parseInt(s.closed_count || 0);
                mtd      += parseFloat(s.total_volume_sum || 0);
                vol90    += parseFloat(s.total_volume_90d_sum || 0);
            });

            const equip = { stocked: 0, deployed: 0, repair: 0 };
            (equipRows.data || []).forEach(e => {
                if (e.status === 'deployed') equip.deployed++;
                else if ((e.current_location || '').toLowerCase().includes('repair')) equip.repair++;
                else equip.stocked++;
            });

            return res.status(200).json({
                success: true,
                kpis: {
                    approved, pending, closed,
                    total_mtd: mtd,
                    total_90d: vol90,
                    active_deployments: deploymentCount.count || 0,
                    open_rmas: openRmaCount.count || 0,
                    new_this_week: newThisWeek.count || 0,
                    equipment: equip
                },
                recent_activity: recentActivity.data || []
            });
        }

        if (action === 'get_at_risk') {
            const { data, error } = await supabase
                .from('merchants')
                .select('merchant_id, dba_name, agent_id, agent_name, volume_30_day, volume_90_day, last_batch_date')
                .eq('account_status', 'Approved')
                .gt('volume_90_day', 0)
                .order('volume_30_day', { ascending: true })
                .limit(2000);

            if (error) throw error;

            const atRisk = (data || [])
                .map(m => {
                    const baseline = parseFloat(m.volume_90_day) / 3;
                    const vol30 = parseFloat(m.volume_30_day);
                    return { ...m, baseline, drop_pct: Math.round((1 - vol30 / baseline) * 100) };
                })
                .filter(m => m.drop_pct >= 15)
                .sort((a, b) => b.drop_pct - a.drop_pct);

            return res.status(200).json({ success: true, data: atRisk });
        }

        if (action === 'get_merchant_detail') {
            const { merchant_id } = req.body;
            const { data: merchant, error: mErr } = await supabase
                .from('merchants')
                .select('merchant_id, dba_name, agent_id, agent_name, volume_30_day, volume_90_day, last_batch_date, account_status, enrollment_date, merchant_phone, merchant_city, merchant_state')
                .eq('merchant_id', merchant_id)
                .single();
            if (mErr) throw mErr;

            let partner = null;
            if (merchant?.agent_id) {
                const { data: agentId } = await supabase
                    .from('agent_identifiers')
                    .select('id_string, agents!agent_identifiers_agent_id_fkey(agent_name, persons!agents_parent_agent_id_fkey(full_name, email, phone_number))')
                    .eq('id_string', merchant.agent_id)
                    .single();
                if (agentId?.agents) {
                    partner = {
                        agent_name: agentId.agents.agent_name,
                        full_name: agentId.agents.persons?.full_name || null,
                        email: agentId.agents.persons?.email || null,
                        phone_number: agentId.agents.persons?.phone_number || null
                    };
                }
            }
            return res.status(200).json({ success: true, merchant, partner });
        }

        if (action === 'get_recent_deployments') {
            const { data, error } = await supabase
                .from('deployments')
                .select('id, deployment_id, status, created_at, purchase_type, tracking_id, notes, shipping_address, recipient_name, merchants:merchant_id(dba_name, merchant_id), equipments:equipment_id(serial_number, terminal_type)')
                .order('created_at', { ascending: false })
                .limit(8);
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'get_deployment_detail') {
            const { deployment_id } = req.body;
            const { data, error } = await supabase
                .from('deployments')
                .select('id, deployment_id, status, created_at, updated_at, purchase_type, tracking_id, notes, shipping_address, recipient_name, merchants:merchant_id(dba_name, merchant_id, merchant_city, merchant_state, merchant_phone), equipments:equipment_id(serial_number, terminal_type)')
                .eq('id', deployment_id)
                .single();
            if (error) throw error;
            return res.status(200).json({ success: true, data });
        }

        if (action === 'get_priority_tickets') {
            const { priority } = req.body;
            let q = supabase.from('support_tickets')
                .select('id, ticket_number, type, subject, status, priority, assigned_to, created_at, merchants:merchant_id(dba_name, merchant_id), persons:person_id(full_name)')
                .neq('status', 'closed')
                .order('created_at', { ascending: false })
                .limit(50);
            if (priority && priority !== 'all') {
                q = q.eq('priority', priority);
            } else {
                q = q.in('priority', ['urgent', 'high']);
            }
            const { data, error } = await q;
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'send_partner_alerts') {
            const { merchant_ids } = req.body;
            if (!merchant_ids || !merchant_ids.length) return res.status(400).json({ success: false, message: 'No merchant IDs provided.' });

            const { data: merchants } = await supabase
                .from('merchants')
                .select('merchant_id, dba_name, agent_id, agent_name, volume_30_day, volume_90_day, last_batch_date')
                .in('merchant_id', merchant_ids);

            if (!merchants || !merchants.length) return res.status(400).json({ success: false, message: 'No merchants found.' });

            // Group merchants by agent_id
            const byAgent = {};
            for (const m of merchants) {
                if (!m.agent_id) continue;
                if (!byAgent[m.agent_id]) byAgent[m.agent_id] = [];
                byAgent[m.agent_id].push(m);
            }

            let emailsSent = 0;
            const agentIds = Object.keys(byAgent);

            for (const agentId of agentIds) {
                const { data: agentRec } = await supabase
                    .from('agent_identifiers')
                    .select('agents!agent_identifiers_agent_id_fkey(agent_name, persons!agents_parent_agent_id_fkey(full_name, email))')
                    .eq('id_string', agentId)
                    .single();

                const partner = agentRec?.agents?.persons;
                if (!partner?.email) continue;

                const agentName = agentRec?.agents?.agent_name || agentId;
                const merchantList = byAgent[agentId];

                if (process.env.POSTMARK_SERVER_TOKEN) {
                    try {
                        const { ServerClient } = await import('postmark');
                        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                        const rows = merchantList.map(m => {
                            const baseline = parseFloat(m.volume_90_day) / 3;
                            const drop = Math.round((1 - parseFloat(m.volume_30_day) / baseline) * 100);
                            return `<tr style="border-bottom:1px solid #e2e8f0;">
                                <td style="padding:10px 12px; font-weight:600;">${m.dba_name}</td>
                                <td style="padding:10px 12px; font-family:monospace; font-size:12px;">${m.merchant_id}</td>
                                <td style="padding:10px 12px; color:#dc2626; font-weight:700;">-${drop}%</td>
                                <td style="padding:10px 12px; color:#64748b;">${m.last_batch_date ? new Date(m.last_batch_date).toLocaleDateString() : '—'}</td>
                            </tr>`;
                        }).join('');
                        await client.sendEmail({
                            From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
                            To: partner.email,
                            Subject: `Action Required: ${merchantList.length} At-Risk Merchant${merchantList.length > 1 ? 's' : ''} in Your Portfolio`,
                            HtmlBody: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
                                <img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:36px;margin-bottom:24px;display:block;">
                                <h2 style="color:#001e3c;margin-bottom:8px;">Volume Alert — Immediate Attention Needed</h2>
                                <p style="color:#475569;line-height:1.6;">Hi <strong>${partner.full_name || agentName}</strong>, the following merchant(s) in your portfolio have shown a significant drop in processing volume and may need your attention:</p>
                                <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                                    <thead><tr style="background:#f8fafc;"><th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;">Merchant</th><th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;">MID</th><th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;">Drop</th><th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;">Last Batch</th></tr></thead>
                                    <tbody>${rows}</tbody>
                                </table>
                                <p style="color:#475569;line-height:1.6;">Please reach out to these merchants to understand if there are any issues we can help resolve.</p>
                                <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0;">
                                <p style="font-size:11px;color:#94a3b8;text-align:center;">PayProTec Partner Portal · Automated Risk Alert</p>
                            </div>`,
                            TextBody: `Hi ${partner.full_name || agentName}, ${merchantList.length} merchant(s) in your portfolio need attention. Please log in to your Partner Portal for details.`,
                            MessageStream: 'outbound'
                        });
                        emailsSent++;
                    } catch (e) {
                        console.error('[ALERT] Email failed for', partner.email, e.message);
                    }
                } else {
                    emailsSent++;
                }
            }

            return res.status(200).json({ success: true, partners_notified: emailsSent, merchant_count: merchants.length });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('Admin Dashboard Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
