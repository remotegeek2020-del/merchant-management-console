// ── Website bot — proactive cold-conversation follow-up (Phase 7) ───────────
// Runs hourly. For bots with follow-up enabled, finds conversations where the
// visitor gave contact info (a HighLevel contact exists) but the
// conversation went quiet for followup_hours — sends one SMS nudge via the
// same ghlSendSms already proven in the Prime49 SMS bot, once per
// conversation (followup_sent_at gates re-sends).
//
// Note: unlike Prime49, there's no dedicated "they actually booked" webhook
// for this bot yet — "went cold" here means no new message in the window,
// which is the closest reliable signal available without that extra wiring.
import { createClient } from '@supabase/supabase-js';
import { ghlSendSms, ghlContactSmsBlocked } from './_ghl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    try {
        const { data: bots } = await supabase.from('bots')
            .select('id, name, ghl_location_id, followup_hours, followup_message').eq('followup_enabled', true).eq('is_active', true);

        let checked = 0, sent = 0;
        for (const bot of (bots || [])) {
            if (!bot.ghl_location_id) continue;
            const hours = Number.isFinite(+bot.followup_hours) && +bot.followup_hours > 0 ? +bot.followup_hours : 24;
            const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
            const { data: convos } = await supabase.from('bot_conversations')
                .select('id, hl_contact_id, visitor_phone, visitor_name').eq('bot_id', bot.id)
                .not('hl_contact_id', 'is', null).not('visitor_phone', 'is', null)
                .is('followup_sent_at', null).lte('updated_at', cutoff).limit(200);
            checked += (convos || []).length;
            const text = bot.followup_message || `Hi! Just checking back in — still have questions, or ready to book a time? Happy to help whenever you're ready.`;
            for (const c of (convos || [])) {
                if (await ghlContactSmsBlocked(bot.ghl_location_id, c.hl_contact_id)) {
                    await supabase.from('bot_conversations').update({ followup_sent_at: new Date().toISOString() }).eq('id', c.id);
                    continue;
                }
                const r = await ghlSendSms(bot.ghl_location_id, c.hl_contact_id, text);
                await supabase.from('bot_conversations').update({ followup_sent_at: new Date().toISOString() }).eq('id', c.id);
                if (r.ok) sent++;
            }
        }
        return res.status(200).json({ success: true, checked, sent });
    } catch (e) {
        console.error('[cron-bot-followup]', e.message);
        return res.status(200).json({ success: false, message: e.message });
    }
}
