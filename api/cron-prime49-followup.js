// ── Prime49 Path B no-show follow-up ─────────────────────────────────────────
// Runs every 5 minutes. For every campaign with follow-up enabled, finds
// qualified prospective submissions that haven't converted (booked/filled)
// within the staff-configured window and applies a follow-up tag/workflow —
// once per submission (followup_sent_at gates re-triggering).
import { createClient } from '@supabase/supabase-js';
import { ghlAddContactTags, ghlAddContactToWorkflow } from './_ghl.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    try {
        const { data: configs } = await supabase.from('prime49_configs')
            .select('campaign_id, ghl_location_id, survey_followup_minutes, survey_followup_tag, survey_followup_workflow_id')
            .eq('survey_followup_enabled', true);

        let checked = 0, triggered = 0;
        for (const cfg of (configs || [])) {
            if (!cfg.ghl_location_id || (!cfg.survey_followup_tag && !cfg.survey_followup_workflow_id)) continue;
            const minutes = Number.isFinite(+cfg.survey_followup_minutes) && +cfg.survey_followup_minutes > 0 ? +cfg.survey_followup_minutes : 10;
            const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
            const { data: subs } = await supabase.from('prime49_submissions')
                .select('id, hl_contact_id').eq('campaign_id', cfg.campaign_id).eq('path', 'prospective')
                .eq('qualified', true).eq('converted', false).is('followup_sent_at', null)
                .not('hl_contact_id', 'is', null).lte('created_at', cutoff).limit(200);
            checked += (subs || []).length;
            for (const s of (subs || [])) {
                if (cfg.survey_followup_tag) await ghlAddContactTags(cfg.ghl_location_id, s.hl_contact_id, [cfg.survey_followup_tag]);
                if (cfg.survey_followup_workflow_id) await ghlAddContactToWorkflow(cfg.ghl_location_id, s.hl_contact_id, cfg.survey_followup_workflow_id);
                await supabase.from('prime49_submissions').update({ followup_sent_at: new Date().toISOString() }).eq('id', s.id);
                triggered++;
            }
        }
        return res.status(200).json({ success: true, checked, triggered });
    } catch (e) {
        console.error('[cron-prime49-followup]', e.message);
        return res.status(200).json({ success: false, message: e.message });
    }
}
