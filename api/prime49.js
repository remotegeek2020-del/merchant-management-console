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
import { GoogleGenerativeAI } from '@google/generative-ai';
import { applyRsvpTagWorkflow } from './rsvp.js';
import { ghlSetContactCustomFieldsByName, ghlCalendarFreeSlots } from './_ghl.js';
import { getConfigValue } from './api-config.js';

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
    const prime49Ids = new Set(idents.filter(i => i.prime49).map(i => i.id_string));
    if (!idStrings.length) return { merchants: [], eligible: false, prime49Ids };
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
    return { merchants: rows, eligible: rows.some(r => r.eligible), prime49Ids };
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
// Walks Gemini's ranked rep list and returns the first one whose calendar
// actually has open slots in the next 14 days — so a rep who's fully
// blocked out never gets assigned just because they were the top pick.
// Fails open on an availability-check error (treats it as available)
// rather than skipping a rep just because HighLevel hiccuped.
async function firstAvailableRep(locationId, reps, rankedIds) {
    const now = Date.now(), horizon = now + 14 * 24 * 60 * 60 * 1000;
    for (const id of rankedIds) {
        const rep = reps.find(r => String(r.ghl_user_id) === String(id));
        if (!rep) continue;
        if (!rep.calendar_id) continue;
        const slots = await ghlCalendarFreeSlots(locationId, rep.calendar_id, now, horizon);
        if (slots === null || slots > 0) return rep;
    }
    return null;
}
function evaluateSurvey(fields, answers, mode) {
    const results = fields.map(f => fieldQualifies(f, answers)).filter(r => r !== null);
    if (!results.length) return true;
    return mode === 'any' ? results.some(Boolean) : results.every(Boolean);
}

// AI assessment (Path B, when staff enables it): Gemini reads the survey
// answers against staff-written criteria and — if it qualifies — picks the
// best-fit rep from the staff-configured pool. Returns null on any failure
// (no key configured, bad JSON, API error) so the caller can fail closed
// with a retry message rather than silently guessing.
async function assessWithGemini(cfg, fields, answers) {
    const key = process.env.GEMINI_API_KEY || (await getConfigValue('GEMINI_API_KEY')) || '';
    if (!key) return null;
    const reps = Array.isArray(cfg.survey_reps) ? cfg.survey_reps : [];
    try {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } });
        const qa = fields.map(f => `- ${f.label || f.name}: ${JSON.stringify(answers[f.name] == null ? '' : answers[f.name])}`).join('\n') || '(no questions configured)';
        const repList = reps.length
            ? reps.map(r => `- id:"${r.ghl_user_id}" name:"${r.name || ''}" notes:"${r.notes || ''}"`).join('\n')
            : '(no reps configured — return rep_id:null)';
        // Staff can pre-assign a ranked list of reps to specific answer options
        // (e.g. "Learn how to sell merchant services" -> 1. Jasilee, 2. Danny,
        // 3. Jenn). Surface every one the applicant actually triggered as a
        // strong signal — Gemini still makes the final call, aggregating
        // across all of these plus the general rep notes above.
        const voteLines = [];
        fields.forEach(f => {
            if (!f.option_reps || typeof f.option_reps !== 'object') return;
            const given = answers[f.name];
            const givenArr = Array.isArray(given) ? given.map(String) : [String(given == null ? '' : given)];
            givenArr.forEach(val => {
                const ranked = f.option_reps[val];
                if (Array.isArray(ranked) && ranked.length) {
                    voteLines.push(`- For "${f.label || f.name}" = "${val}", staff ranked: ${ranked.map((id, i) => `${i + 1}. id:"${id}"`).join(', ')}`);
                }
            });
        });
        const voteBlock = voteLines.length
            ? voteLines.join('\n')
            : '(no answer-specific rep priorities apply to this application)';
        const prompt = `You are assessing a prospective partner application for PayProTec's Prime49 program.

Staff qualifying criteria:
${cfg.survey_ai_criteria || '(none provided — use your best judgment on general fit for a payment processing referral partner program)'}

Applicant's answers:
${qa}

Sales reps available to assign if the applicant qualifies (rank ALL of them best-fit first; if none fit well or none are listed, return an empty list):
${repList}

Staff pre-ranked rep priorities triggered by this applicant's specific answers (treat as a strong signal — lower number = higher priority; if multiple answers point to different reps, weigh them together with the rep notes above to decide the overall ranking):
${voteBlock}

One of the ranked reps may turn out to be unavailable on their calendar — that's checked separately after your ranking, so ALWAYS return every rep you'd consider acceptable, ordered best-fit first, not just your single top pick.

Return ONLY strict JSON, no markdown: {"qualified": true or false, "rep_ids": ["<id>", "<id>", ...] (best fit first, empty array if none fit), "reasoning": "<one or two sentences explaining the ranking, mentioning which signals drove it>"}`;
        const r = await model.generateContent(prompt);
        const text = (r && r.response && r.response.text() || '').trim();
        const j = JSON.parse(text);
        return {
            qualified: !!j.qualified,
            rep_ids: Array.isArray(j.rep_ids) ? j.rep_ids.map(id => String(id)).filter(Boolean) : (j.rep_id ? [String(j.rep_id)] : []),
            reasoning: String(j.reasoning || '').slice(0, 1000)
        };
    } catch (e) {
        console.error('[prime49] Gemini assessment failed:', e.message);
        return null;
    }
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
                eligible_headline: cfg.eligible_headline, eligible_body: cfg.eligible_body,
                not_eligible_headline: cfg.not_eligible_headline, not_eligible_body: cfg.not_eligible_body,
                already_enrolled_headline: cfg.already_enrolled_headline, already_enrolled_body: cfg.already_enrolled_body,
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

            const { merchants, eligible, prime49Ids } = await eligibilityForPerson(p.person_id, cfg.min_volume, cfg.max_volume);
            // Any Partner ID belonging to this SAME PERSON is already enrolled
            // in Prime49 (agent_identifiers.prime49) — not just the exact ID
            // they typed. Someone can hold several IDs (e.g. one already in
            // Prime49, one they just typed that isn't) and still be "already
            // in the program" as a person. Tell them directly instead of
            // lumping this in with the generic "not eligible" message.
            const alreadyEnrolled = prime49Ids.size > 0;
            const email = String(body.email || p.email || '').trim();
            const phone = String(body.phone || p.phone || '').trim();
            const name = String(p.full_name || '').trim();

            let contactId = null, tagApplied = false, error = null;
            if (eligible && !alreadyEnrolled && cfg.ghl_location_id) {
                const r = await applyRsvpTagWorkflow(cfg.ghl_location_id, p, name, email, phone, { rsvp_tag: cfg.eligible_tag, workflow_id: cfg.eligible_workflow_id });
                contactId = r.contactId || null; tagApplied = r.tagApplied; error = r.error;
            }
            const { data: inserted } = await supabase.from('prime49_submissions').insert({
                campaign_id: campaignId, path: 'existing', partner_id_string: pid, person_id: p.person_id || null,
                hl_contact_id: contactId || p.hl_contact_id || null, email, name,
                eligible, qualifying_merchants: merchants, tag_applied: tagApplied, hl_error: error || null
            }).select('id').single();

            return ok(res, {
                status: 'found', name, email, phone, eligible, merchants, already_enrolled: alreadyEnrolled,
                submission_id: inserted ? inserted.id : null,
                ...(!alreadyEnrolled && eligible ? bookingInfo(cfg, 'eligible', { email, phone, ...splitName(name) }) : {})
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
            // AI assessment (if staff turned it on) replaces the rule-based
            // qualify logic AND picks the rep to assign. If Gemini can't be
            // reached or returns something unusable, fail closed with a retry
            // message rather than silently falling back or guessing a rep.
            let qualified, assignedRep = null, aiReasoning = null, aiRaw = null;
            if (cfg.survey_ai_enabled) {
                const assessment = await assessWithGemini(cfg, fields, answers);
                if (!assessment) return bad(res, "We couldn't process your application right now. Please try again in a moment.");
                qualified = assessment.qualified;
                aiReasoning = assessment.reasoning;
                aiRaw = assessment;
                if (qualified && assessment.rep_ids && assessment.rep_ids.length && cfg.ghl_location_id) {
                    assignedRep = await firstAvailableRep(cfg.ghl_location_id, cfg.survey_reps || [], assessment.rep_ids);
                    if (!assignedRep) aiReasoning = (aiReasoning ? aiReasoning + ' ' : '') + '(All ranked reps were fully booked in the next 2 weeks — no rep assigned.)';
                }
            } else {
                qualified = evaluateSurvey(fields, answers, cfg.survey_qualify_mode);
            }

            const name = String(body.name || '').trim();
            const email = String(body.email || '').trim();
            const phone = String(body.phone || '').trim();
            // Only a qualifying submission creates/updates the HighLevel
            // contact — the tag/workflow (if configured) is applied at the
            // same time, and the contact is assigned to the AI-picked rep
            // BEFORE they book.
            let contactId = null, tagApplied = false, error = null;
            if (qualified && cfg.ghl_location_id) {
                const ev = { rsvp_tag: cfg.survey_tag, assigned_to: assignedRep ? assignedRep.ghl_user_id : undefined };
                const r = await applyRsvpTagWorkflow(cfg.ghl_location_id, { hl_contact_id: null }, name, email, phone, ev);
                contactId = r.contactId || null; tagApplied = r.tagApplied; error = r.error;
                if (contactId) {
                    // Keyed by the REAL HighLevel custom field name staff mapped
                    // this question to — the auto-generated internal field name
                    // (f.name, e.g. "q0_whats_your_experience...") never matches
                    // an actual HighLevel field, which is why this silently did
                    // nothing before the mapping picker existed.
                    const cfMap = {};
                    fields.forEach(f => { if (!f.hl_field) return; const v = answers[f.name]; if (v != null && String(v).trim() !== '') cfMap[f.hl_field] = v; });
                    if (Object.keys(cfMap).length) await ghlSetContactCustomFieldsByName(cfg.ghl_location_id, contactId, cfMap);
                }
            }
            const { data: inserted } = await supabase.from('prime49_submissions').insert({
                campaign_id: campaignId, path: 'prospective', hl_contact_id: contactId, email, phone, name,
                survey_answers: answers, qualified, tag_applied: tagApplied, hl_error: error || null,
                assigned_rep_ghl_user_id: assignedRep ? assignedRep.ghl_user_id : null,
                assigned_rep_name: assignedRep ? assignedRep.name : null,
                ai_reasoning: aiReasoning, ai_raw: aiRaw
            }).select('id').single();
            // With a rep assigned, hand back their profile + their own
            // calendar (in place of the campaign's default booking setup) —
            // "paired with a rep" always means seeing that specific person.
            // Bio/photo/job level come from app_users (the same fields staff
            // set via the Secret Dungeon rep-profile bypass), not duplicated
            // into the campaign config.
            let repBooking = null;
            if (assignedRep && assignedRep.calendar_id) {
                const { data: repUser } = await supabase.from('app_users')
                    .select('userid, first_name, last_name, email, rep_bio, rep_job_level, rep_photo_url, rep_professional_role, rep_industry_context')
                    .eq('ghl_user_id', assignedRep.ghl_user_id).maybeSingle();
                let avatarUrl = '';
                if (repUser) {
                    const { data: prof } = await supabase.from('user_profiles').select('avatar_url').eq('user_id', repUser.userid).maybeSingle();
                    avatarUrl = (prof && prof.avatar_url) || '';
                }
                repBooking = {
                    booking_mode: 'calendar', calendar_id: assignedRep.calendar_id, prefill: { email, phone, ...splitName(name) },
                    rep: {
                        name: repUser ? (`${repUser.first_name || ''} ${repUser.last_name || ''}`.trim() || repUser.email) : (assignedRep.name || ''),
                        photo: avatarUrl || (repUser && repUser.rep_photo_url) || '',
                        bio: (repUser && repUser.rep_bio) || '',
                        job_level: (repUser && repUser.rep_job_level) || '',
                        professional_role: (repUser && Array.isArray(repUser.rep_professional_role)) ? repUser.rep_professional_role : [],
                        industry_context: (repUser && repUser.rep_industry_context) || ''
                    }
                };
            }
            return ok(res, {
                qualified,
                submission_id: inserted ? inserted.id : null,
                headline: qualified ? (cfg.qualified_headline || "You're a great fit!") : (cfg.declined_headline || 'Thanks for your interest'),
                body: qualified ? (cfg.qualified_body || null) : (cfg.declined_body || null),
                ...(repBooking || (qualified ? bookingInfo(cfg, 'survey', { email, phone, ...splitName(name) }) : {}))
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
