// ── PRIME49 popup — public flow ──────────────────────────────────────────────
// Long-running, brand-level campaign (campaign_kind='prime49') with two paths,
// both run entirely INSIDE the popup, no separate page:
//   A) "I am a PPT Partner"        → Partner ID lookup → cross-ID merchant
//                                     eligibility check ($ volume band) → if
//                                     eligible, tag/workflow applied and a
//                                     calendar or form is handed back, all in
//                                     one round trip (no separate confirm step).
//   B) "I am interested in..."     → a staff-defined qualifying survey →
//                                     pass/fail → calendar/form (pass) or a
//                                     decline message (fail).
import { createClient } from '@supabase/supabase-js';
import { applyRsvpTagWorkflow } from './rsvp.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
}
const ok = (res, data = {}) => res.status(200).json({ success: true, ...data });
const bad = (res, message) => res.status(200).json({ success: false, message });

async function loadConfig(campaignId) {
    if (!campaignId) return null;
    const { data } = await supabase.from('prime49_configs').select('*').eq('campaign_id', campaignId).maybeSingle();
    return data;
}

// Given a resolved person_id, find every Partner ID (agent_identifiers.id_string)
// tied to that same person (agents.parent_agent_id = person_id), same chain
// documented repo-wide: merchants.agent_id -> agent_identifiers.id_string ->
// agents.id -> persons (parent_agent_id).
async function allIdStringsForPerson(personId) {
    if (!personId) return [];
    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    const agentUuids = (agents || []).map(a => a.id);
    if (!agentUuids.length) return [];
    const { data: idents } = await supabase.from('agent_identifiers').select('id_string, prime49').in('agent_id', agentUuids);
    return idents || [];
}

// Cross-ID merchant eligibility: every merchant under ANY of this person's
// Partner IDs, grouped by which ID it's under, flagged eligible when its
// 30-day volume falls in [minVolume, maxVolume] (inclusive) and it isn't
// already enrolled in Prime49.
async function eligibilityForPerson(personId, minVolume, maxVolume) {
    const idents = await allIdStringsForPerson(personId);
    const idStrings = idents.map(i => i.id_string).filter(Boolean);
    if (!idStrings.length) return { merchants: [], eligible: false };
    const prime49Ids = new Set(idents.filter(i => i.prime49).map(i => i.id_string));
    const { data: merchants } = await supabase.from('merchant_portfolio_view')
        .select('merchant_id, dba_name, agent_id, account_status, volume_30_day, company_display_name')
        .in('agent_id', idStrings).limit(5000);
    const rows = (merchants || []).map(m => {
        const vol = parseFloat(m.volume_30_day) || 0;
        const alreadyPrime49 = prime49Ids.has(m.agent_id);
        const inBand = vol >= minVolume && vol <= maxVolume;
        return {
            partner_id_string: m.agent_id, dba_name: m.dba_name || m.company_display_name || m.merchant_id,
            merchant_id: m.merchant_id, account_status: m.account_status,
            volume_30_day: vol, already_prime49: alreadyPrime49, eligible: inBand && !alreadyPrime49
        };
    });
    return { merchants: rows, eligible: rows.some(r => r.eligible) };
}

// What to hand the visitor once they qualify: either a HighLevel calendar
// (booking widget) or a HighLevel form — staff's choice, set independently
// per path ('eligible' for Path A, 'survey' for Path B).
function bookingInfo(cfg, path, prefill) {
    const mode = cfg[path + '_booking_mode'];
    const formId = cfg[path + '_form_id'];
    const calId = cfg[path + '_calendar_id'];
    const p = prefill || {};
    if (mode === 'form' && formId) return { booking_mode: 'form', form_id: formId, prefill: p };
    if (calId) return { booking_mode: 'calendar', calendar_id: calId, prefill: p };
    return { booking_mode: null };
}
function splitName(name) {
    const s = String(name || '').trim();
    if (!s) return { first_name: '', last_name: '' };
    const parts = s.split(/\s+/);
    return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

// Does this ONE question's answer qualify, per however staff configured it?
// Returns null when the question isn't set up as a qualifying question at all
// (informational only) so it's excluded from the overall pass/fail decision.
function fieldQualifies(f, answers) {
    const given = answers[f.name];
    if (f.type === 'number') {
        if (f.qualify_min == null && f.qualify_max == null) return null;
        const v = parseFloat(given);
        if (Number.isNaN(v)) return false;
        if (f.qualify_min != null && v < f.qualify_min) return false;
        if (f.qualify_max != null && v > f.qualify_max) return false;
        return true;
    }
    if (f.type === 'dropdown' || f.type === 'checkbox') {
        if (!Array.isArray(f.qualify) || !f.qualify.length) return null;
        const givenArr = Array.isArray(given) ? given.map(String) : [String(given == null ? '' : given)];
        return givenArr.some(v => f.qualify.includes(v));
    }
    // text / textarea: qualifies if the answer contains any of the configured
    // keywords/phrases (case-insensitive).
    if (!Array.isArray(f.qualify) || !f.qualify.length) return null;
    const s = String(given == null ? '' : given).toLowerCase();
    return f.qualify.some(k => s.indexOf(String(k).toLowerCase()) !== -1);
}
function evaluateSurvey(fields, answers, mode) {
    const results = fields.map(f => fieldQualifies(f, answers)).filter(r => r !== null);
    if (!results.length) return true;
    return mode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const action = body?.action;
    const campaignId = body?.campaign_id;

    try {
        if (action === 'config') {
            const cfg = await loadConfig(campaignId);
            if (!cfg || !cfg.enabled) return bad(res, 'This is not available.');
            return ok(res, { config: {
                eligible_headline: cfg.eligible_headline, eligible_body: cfg.eligible_body, not_eligible_body: cfg.not_eligible_body,
                survey_fields: (cfg.survey_fields || []).map(f => ({ name: f.name, label: f.label, type: f.type, required: !!f.required, options: f.options || [] })),
                qualified_headline: cfg.qualified_headline, qualified_body: cfg.qualified_body,
                declined_headline: cfg.declined_headline, declined_body: cfg.declined_body,
                merchant_support_headline: cfg.merchant_support_headline, merchant_support_body: cfg.merchant_support_body
            } });
        }

        // Path A — existing partner: look up by Partner ID, consolidate every
        // merchant under every ID that same person holds, report eligibility,
        // and — if eligible — apply the tag/workflow and hand back the booking
        // step immediately. One round trip; no separate "confirm" click.
        if (action === 'lookup_existing') {
            const cfg = await loadConfig(campaignId);
            if (!cfg || !cfg.enabled) return bad(res, 'This is not available.');
            const pid = String(body.partner_id || '').trim();
            if (!pid) return bad(res, 'Enter your Partner ID.');
            const { data } = await supabase.rpc('partner_contact_by_id', { p_id: pid });
            const p = Array.isArray(data) && data[0] ? data[0] : null;
            if (!p) return ok(res, { status: 'not_found' });

            const { merchants, eligible } = await eligibilityForPerson(p.person_id, cfg.min_volume, cfg.max_volume);
            const email = String(body.email || p.email || '').trim();
            const phone = String(body.phone || p.phone || '').trim();
            const name = String(p.full_name || '').trim();

            let contactId = null, tagApplied = false, error = null;
            if (eligible && cfg.ghl_location_id) {
                const r = await applyRsvpTagWorkflow(cfg.ghl_location_id, p, name, email, phone, { rsvp_tag: cfg.eligible_tag, workflow_id: cfg.eligible_workflow_id });
                contactId = r.contactId || null; tagApplied = r.tagApplied; error = r.error;
            }
            const { data: inserted } = await supabase.from('prime49_submissions').insert({
                campaign_id: campaignId, path: 'existing', partner_id_string: pid, person_id: p.person_id || null,
                hl_contact_id: contactId || p.hl_contact_id || null, email, name,
                eligible, qualifying_merchants: merchants, tag_applied: tagApplied, hl_error: error || null
            }).select('id').single();

            return ok(res, {
                status: 'found', name, email, phone, eligible, merchants,
                submission_id: inserted ? inserted.id : null,
                ...(eligible ? bookingInfo(cfg, 'eligible', { email, phone, ...splitName(name) }) : {})
            });
        }

        // Path B — prospective partner: evaluate a staff-defined pass/fail
        // survey. Each question can be marked as qualifying (dropdown/checkbox:
        // pick which options pass; number: a min/max range; text/textarea:
        // keyword match) — non-qualifying questions are informational only.
        // The campaign-level mode decides whether ALL or ANY qualifying
        // questions must pass overall.
        if (action === 'submit_survey') {
            const cfg = await loadConfig(campaignId);
            if (!cfg || !cfg.enabled) return bad(res, 'This is not available.');
            const answers = (body.answers && typeof body.answers === 'object') ? body.answers : {};
            const fields = cfg.survey_fields || [];
            for (const f of fields) {
                if (f.required && !String(answers[f.name] == null ? '' : answers[f.name]).trim()) {
                    return bad(res, `Please answer: ${f.label || f.name}`);
                }
            }
            const qualified = evaluateSurvey(fields, answers, cfg.survey_qualify_mode);

            const name = String(body.name || '').trim();
            const email = String(body.email || '').trim();
            const phone = String(body.phone || '').trim();
            // Qualifying always creates/updates the HighLevel contact, whether or
            // not staff configured a tag/workflow for this path.
            let contactId = null, tagApplied = false, error = null;
            if (qualified && cfg.ghl_location_id) {
                const r = await applyRsvpTagWorkflow(cfg.ghl_location_id, { hl_contact_id: null }, name, email, phone, { rsvp_tag: cfg.survey_tag, workflow_id: cfg.survey_workflow_id });
                contactId = r.contactId || null; tagApplied = r.tagApplied; error = r.error;
            }
            const { data: inserted } = await supabase.from('prime49_submissions').insert({
                campaign_id: campaignId, path: 'prospective', hl_contact_id: contactId, email, phone, name,
                survey_answers: answers, qualified, tag_applied: tagApplied, hl_error: error || null
            }).select('id').single();
            return ok(res, {
                qualified,
                submission_id: inserted ? inserted.id : null,
                headline: qualified ? (cfg.qualified_headline || "You're a great fit!") : (cfg.declined_headline || 'Thanks for your interest'),
                body: qualified ? (cfg.qualified_body || null) : (cfg.declined_body || null),
                ...(qualified ? bookingInfo(cfg, 'survey', { email, phone, ...splitName(name) }) : {})
            });
        }

        // Marks a submission as an actual conversion — they booked the call or
        // filled out the form, not merely eligible/qualified. This is what
        // "successful conversion" means for Prime49 stats.
        if (action === 'record_conversion') {
            const submissionId = body.submission_id;
            if (!submissionId) return bad(res, 'Missing submission id');
            const via = body.via === 'form' ? 'form' : 'calendar';
            await supabase.from('prime49_submissions')
                .update({ converted: true, converted_via: via, converted_at: new Date().toISOString() })
                .eq('id', submissionId).eq('campaign_id', campaignId);
            return ok(res, {});
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        console.error('[prime49]', e.message);
        return bad(res, 'Something went wrong. Please try again.');
    }
}
