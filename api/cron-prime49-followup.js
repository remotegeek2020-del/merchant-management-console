// ── Prime49 Path B no-show follow-up ─────────────────────────────────────────
// Runs every 5 minutes. Two independent mechanisms, both driven off the same
// "qualified but hasn't converted" query, each with its own enable toggle:
//
//   1) Tag/workflow follow-up (survey_followup_enabled) — unchanged: applies
//      a tag and/or enrolls the HighLevel contact in a workflow once,
//      gated by prime49_submissions.followup_sent_at.
//   2) SMS bot (sms_bot_enabled) — opens a prime49_sms_threads row and sends
//      a staff-written opener text. If they don't reply, sends the next
//      opener in the sequence every sms_bot_opener_gap_minutes, up to the
//      configured list. The moment they reply, api/prime49-sms-bot.js takes
//      over (AI-interpreted replies) and this cron stops sending openers for
//      that thread (status moves off 'opening').
import { createClient } from '@supabase/supabase-js';
import { ghlAddContactTags, ghlAddContactToWorkflow, ghlSendSms, ghlContactSmsBlocked } from './_ghl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function runTagWorkflowFollowup(cfg) {
    if (!cfg.survey_followup_enabled) return { checked: 0, triggered: 0 };
    if (!cfg.ghl_location_id || (!cfg.survey_followup_tag && !cfg.survey_followup_workflow_id)) return { checked: 0, triggered: 0 };
    const minutes = Number.isFinite(+cfg.survey_followup_minutes) && +cfg.survey_followup_minutes > 0 ? +cfg.survey_followup_minutes : 10;
    const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
    const { data: subs } = await supabase.from('prime49_submissions')
        .select('id, hl_contact_id').eq('campaign_id', cfg.campaign_id).eq('path', 'prospective')
        .eq('qualified', true).eq('converted', false).is('followup_sent_at', null)
        .not('hl_contact_id', 'is', null).lte('created_at', cutoff).limit(200);
    let triggered = 0;
    for (const s of (subs || [])) {
        if (cfg.survey_followup_tag) await ghlAddContactTags(cfg.ghl_location_id, s.hl_contact_id, [cfg.survey_followup_tag]);
        if (cfg.survey_followup_workflow_id) await ghlAddContactToWorkflow(cfg.ghl_location_id, s.hl_contact_id, cfg.survey_followup_workflow_id);
        await supabase.from('prime49_submissions').update({ followup_sent_at: new Date().toISOString() }).eq('id', s.id);
        triggered++;
    }
    return { checked: (subs || []).length, triggered };
}

async function runSmsBot(cfg) {
    const openers = Array.isArray(cfg.sms_bot_opener_messages) ? cfg.sms_bot_opener_messages.filter(Boolean) : [];
    if (!cfg.ghl_location_id || !openers.length) return { checked: 0, triggered: 0 };
    const gapMs = (Number.isFinite(+cfg.sms_bot_opener_gap_minutes) && +cfg.sms_bot_opener_gap_minutes > 0 ? +cfg.sms_bot_opener_gap_minutes : 60) * 60000;
    const minutes = Number.isFinite(+cfg.survey_followup_minutes) && +cfg.survey_followup_minutes > 0 ? +cfg.survey_followup_minutes : 10;
    const cutoff = new Date(Date.now() - minutes * 60000).toISOString();

    // New threads: qualified, unconverted, past the threshold, not already threaded.
    const { data: subs } = await supabase.from('prime49_submissions')
        .select('id, hl_contact_id, name, phone').eq('campaign_id', cfg.campaign_id).eq('path', 'prospective')
        .eq('qualified', true).eq('converted', false).not('hl_contact_id', 'is', null).lte('created_at', cutoff).limit(200);
    let checked = (subs || []).length, triggered = 0;
    for (const s of (subs || [])) {
        const { data: existing } = await supabase.from('prime49_sms_threads').select('id').eq('submission_id', s.id).maybeSingle();
        if (existing) continue;
        await supabase.from('prime49_sms_threads').insert({
            campaign_id: cfg.campaign_id, submission_id: s.id, hl_contact_id: s.hl_contact_id,
            phone: s.phone || null, name: s.name || null, status: 'opening', opener_index: 0, next_opener_at: new Date().toISOString()
        });
    }

    // Send any opener that's due (new threads due immediately; subsequent
    // openers due sms_bot_opener_gap_minutes after the last one).
    const { data: due } = await supabase.from('prime49_sms_threads')
        .select('id, hl_contact_id, opener_index').eq('campaign_id', cfg.campaign_id).eq('status', 'opening')
        .lte('next_opener_at', new Date().toISOString()).limit(200);
    for (const t of (due || [])) {
        if (t.opener_index >= openers.length) { await supabase.from('prime49_sms_threads').update({ status: 'active' }).eq('id', t.id); continue; }
        if (await ghlContactSmsBlocked(cfg.ghl_location_id, t.hl_contact_id)) { await supabase.from('prime49_sms_threads').update({ status: 'stopped' }).eq('id', t.id); continue; }
        const text = openers[t.opener_index];
        const r = await ghlSendSms(cfg.ghl_location_id, t.hl_contact_id, text);
        const nextIndex = t.opener_index + 1;
        const { data: cur } = await supabase.from('prime49_sms_threads').select('transcript').eq('id', t.id).maybeSingle();
        const transcript = (cur && Array.isArray(cur.transcript)) ? cur.transcript : [];
        if (r.ok) transcript.push({ from: 'bot', text, at: new Date().toISOString() });
        await supabase.from('prime49_sms_threads').update({
            opener_index: nextIndex,
            next_opener_at: nextIndex < openers.length ? new Date(Date.now() + gapMs).toISOString() : null,
            status: nextIndex >= openers.length ? 'active' : 'opening',
            transcript, updated_at: new Date().toISOString()
        }).eq('id', t.id);
        if (r.ok) triggered++;
    }
    return { checked, triggered };
}

export default async function handler(req, res) {
    try {
        const { data: configs } = await supabase.from('prime49_configs')
            .select('campaign_id, ghl_location_id, survey_followup_enabled, survey_followup_minutes, survey_followup_tag, survey_followup_workflow_id, sms_bot_enabled, sms_bot_opener_messages, sms_bot_opener_gap_minutes')
            .or('survey_followup_enabled.eq.true,sms_bot_enabled.eq.true');

        let checked = 0, triggered = 0, smsChecked = 0, smsTriggered = 0;
        for (const cfg of (configs || [])) {
            const tw = await runTagWorkflowFollowup(cfg);
            checked += tw.checked; triggered += tw.triggered;
            if (cfg.sms_bot_enabled) {
                const bot = await runSmsBot(cfg);
                smsChecked += bot.checked; smsTriggered += bot.triggered;
            }
        }
        return res.status(200).json({ success: true, checked, triggered, sms_checked: smsChecked, sms_sent: smsTriggered });
    } catch (e) {
        console.error('[cron-prime49-followup]', e.message);
        return res.status(200).json({ success: false, message: e.message });
    }
}
