// ── Website bot — public chat endpoint ───────────────────────────────────────
// Powers the embeddable widget (bot-widget.js). No staff session required —
// this is the public-facing surface. A bot is identified by its `slug`
// (e.g. "partner-info"), configured/managed by staff in bot-manager.html.
//
// Phase 1: single bot, manually-fed knowledge, plain conversation.
// Phase 2: partner-ID lookup tool (cross-ID Prime49 eligibility, same chain
//          used by api/prime49.js — any ID the person owns, not just one).
// Phase 3: create/update a HighLevel contact + hand back a booking widget
//          (calendar or form, embedded in the same chat panel — never a new
//          tab, same lesson learned from Prime49).
// Phase 4: log the conversation into HighLevel's Conversations tab via a
//          Custom Conversation Provider (a "Website Chat" channel) — not a
//          Note, and not a real SMS. See api/_bot-ghl-provider.js for the
//          OAuth + message-logging details.
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getConfigValue } from './api-config.js';
import { ghlUpsertContact, ghlCalendarFreeSlotsRaw, ghlCreateAppointment, ghlFindOrCreateConversation, ghlAddContactToWorkflow } from './_ghl.js';
import { logProviderMessage } from './_bot-ghl-provider.js';
import { applyRsvpTagWorkflow } from './rsvp.js';
import { firstAvailableRep } from './prime49.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
}
const ok = (res, data = {}) => res.status(200).json({ success: true, ...data });
const bad = (res, message) => res.status(200).json({ success: false, message });

async function loadBot(slug) {
    if (!slug) return null;
    const { data } = await supabase.from('bots').select('*').eq('slug', slug).maybeSingle();
    return data;
}
async function geminiKey() {
    return process.env.GEMINI_API_KEY || (await getConfigValue('GEMINI_API_KEY')) || '';
}

// ── Partner lookup (Phase 2) — same cross-ID chain as api/prime49.js:
// merchants.agent_id -> agent_identifiers.id_string -> agents.id -> persons
// (parent_agent_id). Accepts ANY Partner ID the person owns, not just one.
async function allIdStringsForPerson(personId) {
    if (!personId) return [];
    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', personId);
    const agentUuids = (agents || []).map(a => a.id);
    if (!agentUuids.length) return [];
    const { data: idents } = await supabase.from('agent_identifiers').select('id_string, prime49').in('agent_id', agentUuids);
    return idents || [];
}
async function lookupPartner(bot, partnerId) {
    const pid = String(partnerId || '').trim();
    if (!pid) return { found: false, error: 'No partner ID given.' };
    const { data } = await supabase.rpc('partner_contact_by_id', { p_id: pid });
    const p = Array.isArray(data) && data[0] ? data[0] : null;
    if (!p) return { found: false };
    const idents = await allIdStringsForPerson(p.person_id);
    const idStrings = idents.map(i => i.id_string).filter(Boolean);
    const prime49Ids = new Set(idents.filter(i => i.prime49).map(i => i.id_string));
    let merchants = [];
    if (idStrings.length) {
        const { data: rows } = await supabase.from('merchant_portfolio_view')
            .select('merchant_id, dba_name, agent_id, volume_30_day, company_display_name').in('agent_id', idStrings).limit(500);
        const minV = Number.isFinite(+bot.prime49_min_volume) ? +bot.prime49_min_volume : 20000;
        const maxV = Number.isFinite(+bot.prime49_max_volume) ? +bot.prime49_max_volume : 30000;
        merchants = (rows || []).map(m => {
            const vol = parseFloat(m.volume_30_day) || 0;
            const already = prime49Ids.has(m.agent_id);
            return {
                dba_name: m.dba_name || m.company_display_name || m.merchant_id,
                volume_30_day: vol, already_in_prime49: already,
                qualifies_for_prime49: vol >= minV && vol <= maxV && !already
            };
        });
    }
    return {
        found: true, name: p.full_name || '', email: p.email || '', phone: p.phone || '',
        person_id: p.person_id || null, hl_contact_id: p.hl_contact_id || null,
        already_in_prime49_any_id: idents.some(i => i.prime49),
        merchants
    };
}

function buildFunctionDeclarations(bot) {
    const decls = [
        {
            name: 'lookup_partner',
            description: "Look up an existing PayProTec partner by their Partner ID to check their merchants and whether they qualify for a Prime49 upgrade. Use this ONLY when the visitor says they're already a partner and gives you an ID (or asks to check their Prime49 eligibility). Any Partner ID they own works, even if they have several.",
            parameters: { type: 'object', properties: { partner_id: { type: 'string', description: 'The Partner ID they gave you' } }, required: ['partner_id'] }
        },
        {
            name: 'create_contact_and_offer_booking',
            description: bot.booking_style === 'auto_book'
                ? "Call this ONCE the visitor is ready to move forward AND you have their name and at least an email or phone number. Creates/updates their contact record. Call check_availability next to actually get them on the calendar."
                : "Call this ONLY once the visitor is ready to move forward (wants to become a partner, or is an eligible existing partner ready to book) AND you have their name and at least an email or phone number. Creates/updates their record and (if booking is configured for this assistant) hands them a way to schedule a call.",
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }
                },
                required: ['name']
            }
        }
    ];
    const hasAutoBookCalendar = bot.booking_style === 'auto_book' && bot.booking_mode === 'calendar' && bot.booking_calendar_id;
    const canAssignReps = Array.isArray(bot.survey_reps) && bot.survey_reps.length > 0;
    if (hasAutoBookCalendar || canAssignReps) {
        decls.push({
            name: 'check_availability',
            description: "Call this once you know who to book with (either the bot's default calendar, or a rep just assigned via assess_partner_qualification) AND the visitor has a rough time preference (e.g. 'sometime this week', 'tomorrow afternoon', or no preference — this looks ahead automatically). Returns a short list of real open time slots to read out in plain conversational language (e.g. 'Tuesday at 2:00 PM'), not raw timestamps.",
            parameters: { type: 'object', properties: {}, required: [] }
        });
        decls.push({
            name: 'book_appointment',
            description: "Call this ONLY after the visitor has picked one specific time from the list check_availability gave you. Pass back the EXACT slot_iso value from that list for the time they chose — do not construct or guess a timestamp yourself. Actually books the appointment on the calendar on their behalf and confirms it.",
            parameters: { type: 'object', properties: { slot_iso: { type: 'string', description: 'The exact ISO datetime string from check_availability that the visitor picked' } }, required: ['slot_iso'] }
        });
    }
    if (bot.qualifying_criteria && bot.ghl_location_id) {
        decls.push({
            name: 'assess_partner_qualification',
            description: "Call this ONCE you have asked the qualifying questions described in your instructions AND have the visitor's name and at least an email or phone number. Creates/updates their contact record, records your qualification decision, and — if qualified and reps are configured — assigns the best-fit available rep so booking can proceed. You decide `qualifies` yourself based on the criteria in your instructions and their answers; this tool does not re-check your judgment.",
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
                    qualifies: { type: 'boolean', description: 'Your judgment: does this applicant meet the qualifying criteria you were given?' },
                    reasoning: { type: 'string', description: 'One or two sentences on why, for the record — not shown to the visitor verbatim.' },
                    preferred_rep_ids: {
                        type: 'array', items: { type: 'string' },
                        description: 'Only if qualifies=true and reps are listed in your instructions: their ghl_user_id values, best-fit first, based on their notes and the conversation. Empty array if unsure — the system will pick from the full pool.'
                    }
                },
                required: ['name', 'qualifies']
            }
        });
    }
    if (bot.not_eligible_workflow_id) {
        decls.push({
            name: 'request_rep_followup',
            description: "Call this when an EXISTING partner who does NOT currently qualify for Prime49 says they'd still like a sales rep to reach out. Requires that you already have their contact on file (via lookup_partner finding them, or create_contact_and_offer_booking). Does not book anything — just flags them for outreach.",
            parameters: { type: 'object', properties: {}, required: [] }
        });
    }
    return decls;
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false });
    let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const action = body?.action;
    const slug = String(body?.slug || '').trim();

    try {
        if (action === 'config') {
            const bot = await loadBot(slug);
            if (!bot || !bot.is_active) return bad(res, 'This assistant is not available.');
            // Phase 5: remember revisits. The widget persists visitor_key in
            // localStorage (not sessionStorage), so the same browser coming
            // back later is recognized here.
            const visitorKey = String(body.visitor_key || '').trim();
            let returning = false, visitCount = 1;
            if (visitorKey) {
                const { data: existing } = await supabase.from('bot_visitors').select('visit_count').eq('bot_id', bot.id).eq('visitor_key', visitorKey).maybeSingle();
                if (existing) {
                    returning = true; visitCount = (existing.visit_count || 1) + 1;
                    await supabase.from('bot_visitors').update({ visit_count: visitCount, last_seen_at: new Date().toISOString() }).eq('bot_id', bot.id).eq('visitor_key', visitorKey);
                } else {
                    await supabase.from('bot_visitors').insert({ bot_id: bot.id, visitor_key: visitorKey, visit_count: 1 });
                }
            }
            let welcome = bot.welcome_message || `Hi! I'm ${bot.name}. How can I help?`;
            if (returning) welcome = 'Welcome back! ' + welcome;
            return ok(res, { bot: { name: bot.name, welcome_message: welcome, photo_url: bot.photo_url || null }, returning, visit_count: visitCount });
        }

        if (action === 'message') {
            const bot = await loadBot(slug);
            if (!bot || !bot.is_active) return bad(res, 'This assistant is not available.');
            const visitorKey = String(body.visitor_key || '').trim();
            const text = String(body.text || '').trim();
            if (!visitorKey) return bad(res, 'Missing visitor key.');
            if (!text) return bad(res, 'Say something first.');
            if (text.length > 2000) return bad(res, 'That message is too long.');

            let { data: convo } = await supabase.from('bot_conversations')
                .select('*').eq('bot_id', bot.id).eq('visitor_key', visitorKey).maybeSingle();
            if (!convo) {
                const { data: inserted } = await supabase.from('bot_conversations')
                    .insert({ bot_id: bot.id, visitor_key: visitorKey, messages: [] }).select('*').single();
                convo = inserted;
            }
            const history = Array.isArray(convo.messages) ? convo.messages : [];

            const key = await geminiKey();
            if (!key) return bad(res, "We couldn't process that right now. Please try again shortly.");

            const { data: knowledgeRows } = await supabase.from('bot_knowledge').select('topic, content, source').eq('bot_id', bot.id).limit(200);
            // Crawled facts carry their page URL as `source` — surfaced here so
            // the bot can point back to the actual page ("you can read more
            // here: ...") instead of just asserting facts with no reference.
            const knowledgeBlock = (knowledgeRows || []).length
                ? (knowledgeRows || []).map(k => `- ${k.topic ? k.topic + ': ' : ''}${k.content}${(k.source && /^https?:\/\//.test(k.source)) ? ` [source: ${k.source}]` : ''}`).join('\n')
                : '(no reference material loaded yet — answer generally and honestly say when you do not know something specific)';

            let booking = null; // set by the tool if this turn should surface a booking widget/link
            let lastSlots = []; // ISO slots offered by check_availability, so book_appointment can validate against them
            async function executeTool(name, args) {
                if (name === 'lookup_partner') {
                    const r = await lookupPartner(bot, args.partner_id);
                    // Remember their existing HighLevel contact so later tools
                    // (request_rep_followup, booking) don't need to re-collect
                    // name/email/phone for someone we already found.
                    if (r.found && r.hl_contact_id && !convo.hl_contact_id) {
                        await supabase.from('bot_conversations').update({
                            hl_contact_id: r.hl_contact_id, visitor_name: r.name || null, visitor_email: r.email || null, visitor_phone: r.phone || null
                        }).eq('id', convo.id);
                        convo.hl_contact_id = r.hl_contact_id;
                    }
                    return r;
                }
                if (name === 'request_rep_followup') {
                    if (!bot.not_eligible_workflow_id) return { ok: false, error: 'Not configured for this assistant.' };
                    if (!convo.hl_contact_id) return { ok: false, error: 'No contact on file yet — get their name and email/phone first.' };
                    const r = await ghlAddContactToWorkflow(bot.ghl_location_id, convo.hl_contact_id, bot.not_eligible_workflow_id);
                    if (!r.ok) return { ok: false, error: r.error || 'Could not flag them for follow-up.' };
                    return { ok: true };
                }
                if (name === 'assess_partner_qualification') {
                    const qualifies = !!args.qualifies;
                    const reps = Array.isArray(bot.survey_reps) ? bot.survey_reps : [];
                    const preferredIds = Array.isArray(args.preferred_rep_ids) ? args.preferred_rep_ids.map(String) : [];
                    // Fall back to trying every configured rep (in whatever
                    // order they were added) if the model didn't rank any —
                    // still better than assigning no one when reps exist.
                    const rankOrder = preferredIds.length ? preferredIds : reps.map(r => r.ghl_user_id);
                    let assignedRep = null;
                    if (qualifies && rankOrder.length) {
                        assignedRep = await firstAvailableRep(bot.ghl_location_id, reps, rankOrder);
                    }
                    const r = await applyRsvpTagWorkflow(bot.ghl_location_id, { hl_contact_id: convo.hl_contact_id }, args.name, args.email, args.phone,
                        { assigned_to: assignedRep ? assignedRep.ghl_user_id : undefined });
                    if (!r.contactId) return { ok: false, error: r.error || 'Could not save their contact record.' };
                    await supabase.from('bot_conversations').update({
                        hl_contact_id: r.contactId, visitor_name: args.name || null, visitor_email: args.email || null, visitor_phone: args.phone || null,
                        qualified: qualifies, ai_reasoning: String(args.reasoning || '').slice(0, 1000),
                        assigned_rep_ghl_user_id: assignedRep ? assignedRep.ghl_user_id : null,
                        assigned_rep_name: assignedRep ? assignedRep.name : null,
                        assigned_rep_calendar_id: assignedRep ? (assignedRep.calendar_id || null) : null
                    }).eq('id', convo.id);
                    convo.hl_contact_id = r.contactId;
                    convo.assigned_rep_calendar_id = assignedRep ? (assignedRep.calendar_id || null) : null;
                    if (!qualifies) return { ok: true, qualified: false };
                    const effectiveCalendar = convo.assigned_rep_calendar_id || (bot.booking_mode === 'calendar' ? bot.booking_calendar_id : null);
                    return {
                        ok: true, qualified: true,
                        rep_assigned: !!assignedRep, rep_name: assignedRep ? assignedRep.name : null,
                        booking_available: !!effectiveCalendar,
                        note: effectiveCalendar ? 'Call check_availability next.' : 'No calendar available right now — tell them a team member will personally follow up instead of promising a booking.'
                    };
                }
                if (name === 'create_contact_and_offer_booking') {
                    if (!bot.ghl_location_id) return { ok: false, error: 'Booking is not configured for this assistant yet. Do not promise a widget or a link — offer to have a person follow up instead.' };
                    const r = await ghlUpsertContact(bot.ghl_location_id, { name: args.name, email: args.email, phone: args.phone }, []);
                    if (!r.ok || !r.id) return { ok: false, error: r.error || 'Could not create the contact.' };
                    await supabase.from('bot_conversations').update({
                        hl_contact_id: r.id, visitor_name: args.name || null, visitor_email: args.email || null, visitor_phone: args.phone || null
                    }).eq('id', convo.id);
                    convo.hl_contact_id = r.id;
                    await supabase.from('bot_visitors').update({ hl_contact_id: r.id }).eq('bot_id', bot.id).eq('visitor_key', visitorKey);

                    // Whether a booking mechanism is actually configured for THIS
                    // bot — surfaced back to the model so it never claims a
                    // widget/link is coming when nothing was actually set up in
                    // bot-manager (the bug the user hit: it said "you should see
                    // a booking widget appear shortly" with nothing configured).
                    const hasForm = bot.booking_mode === 'form' && !!bot.booking_form_id;
                    const hasCalendar = bot.booking_mode === 'calendar' && !!bot.booking_calendar_id;
                    if (bot.booking_style === 'auto_book' && hasCalendar) {
                        return { ok: true, booking_available: true, mode: 'auto_book' };
                    }
                    if (bot.booking_style === 'link' && (hasForm || hasCalendar)) {
                        const url = hasForm
                            ? `https://api.leadconnectorhq.com/widget/form/${encodeURIComponent(bot.booking_form_id)}`
                            : `https://api.leadconnectorhq.com/widget/booking/${encodeURIComponent(bot.booking_calendar_id)}`;
                        booking = { mode: 'link', url };
                        return { ok: true, booking_available: true, mode: 'link' };
                    }
                    if (hasForm) { booking = { mode: 'form', form_id: bot.booking_form_id }; return { ok: true, booking_available: true, mode: 'widget' }; }
                    if (hasCalendar) { booking = { mode: 'calendar', calendar_id: bot.booking_calendar_id }; return { ok: true, booking_available: true, mode: 'widget' }; }
                    return { ok: true, booking_available: false, note: 'Contact saved, but no calendar/form is configured for this assistant — do NOT tell the visitor a widget or link is coming. Instead say a team member will follow up with them directly.' };
                }
                if (name === 'check_availability') {
                    // A rep assigned via assess_partner_qualification books on
                    // THEIR own calendar; otherwise fall back to the bot's
                    // single default calendar.
                    const calendarId = convo.assigned_rep_calendar_id || bot.booking_calendar_id;
                    if (!bot.ghl_location_id || !calendarId) return { ok: false, error: 'No calendar configured.' };
                    const now = Date.now();
                    const slots = await ghlCalendarFreeSlotsRaw(bot.ghl_location_id, calendarId, now, now + 9 * 24 * 60 * 60 * 1000);
                    lastSlots = slots.slice(0, 8);
                    if (!lastSlots.length) return { ok: true, slots: [], note: 'No open times found in the next 9 days — apologize and offer to have a person follow up instead.' };
                    return { ok: true, slots: lastSlots };
                }
                if (name === 'book_appointment') {
                    const calendarId = convo.assigned_rep_calendar_id || bot.booking_calendar_id;
                    if (!bot.ghl_location_id || !calendarId) return { ok: false, error: 'No calendar configured.' };
                    if (!convo.hl_contact_id) return { ok: false, error: 'No contact on file yet — call create_contact_and_offer_booking first.' };
                    const slot = String(args.slot_iso || '');
                    if (lastSlots.length && !lastSlots.includes(slot)) {
                        return { ok: false, error: 'That is not one of the times just offered — re-run check_availability and use an exact slot value, or ask the visitor to pick again.' };
                    }
                    const r = await ghlCreateAppointment(bot.ghl_location_id, {
                        calendarId, contactId: convo.hl_contact_id, startTime: slot, title: `${bot.name} — website chat booking`
                    });
                    if (!r.ok) return { ok: false, error: r.error || 'Could not book that time — apologize and offer to have a person follow up instead.' };
                    return { ok: true, booked: true, start_time: slot };
                }
                return { ok: false, error: 'Unknown tool' };
            }

            const { data: visitorRow } = await supabase.from('bot_visitors').select('visit_count, first_seen_at').eq('bot_id', bot.id).eq('visitor_key', visitorKey).maybeSingle();
            const visitorContext = (visitorRow && visitorRow.visit_count > 1)
                ? `This visitor has been here ${visitorRow.visit_count} times before (first visit ${new Date(visitorRow.first_seen_at).toDateString()}) — acknowledge that naturally if relevant, don't repeat your full introduction.`
                : 'This looks like this visitor\'s first time chatting with you.';

            try {
                const genAI = new GoogleGenerativeAI(key);
                const model = genAI.getGenerativeModel({
                    model: 'gemini-2.5-flash',
                    generationConfig: { temperature: 0.5 },
                    tools: [{ functionDeclarations: buildFunctionDeclarations(bot) }],
                    systemInstruction: `${bot.persona || 'You are a helpful assistant.'}

${visitorContext}

Your goal in every conversation is to move things toward ONE of these outcomes, in this order of priority: (1) an existing partner booked/connected for their Prime49 upgrade, (2) a qualified new partner application submitted, (3) a merchant pointed to support. General questions are welcome and should be answered helpfully, but steer naturally back toward figuring out which of those three the visitor is, rather than just answering trivia forever.

── Existing partner (has a Partner ID) ──
Call lookup_partner with their ID. If eligible for Prime49: offer to book them — call create_contact_and_offer_booking (or assess_partner_qualification is NOT for this path), then check_availability/book_appointment if auto-booking is available. If NOT eligible${bot.not_eligible_workflow_id ? ': ask if they\'d still like a sales rep to reach out, and if yes, call request_rep_followup (their contact is already on file from the lookup).' : ' and no rep follow-up is configured: let them know politely and answer any other questions.'}

── Prospective partner (wants to become one) ──${bot.qualifying_criteria ? `
Ask about (and use your judgment on qualification against): ${bot.qualifying_criteria}
Once you have a clear picture AND their name plus email or phone, call assess_partner_qualification with your own qualifies:true/false judgment.` : `
No qualifying criteria configured for this assistant yet — once they're ready to move forward and you have their name and email or phone, call create_contact_and_offer_booking.`}
${Array.isArray(bot.survey_reps) && bot.survey_reps.length ? `Reps available to assign if qualified (rank by fit in preferred_rep_ids, best first — an unavailable one is skipped automatically):\n${bot.survey_reps.map(r => `- id:"${r.ghl_user_id}" name:"${r.name || ''}" notes:"${r.notes || ''}"`).join('\n')}` : ''}
After assess_partner_qualification returns qualified:true with booking_available:true, offer to book (check_availability/book_appointment). If qualified:false, let them down politely per your persona — do not book anything.

── Merchant (not a partner, wants help with their account) ──
Tell them: "${bot.merchant_message || 'Please call Merchant Support at 800-226-2273, extension 5382, option 1.'}"

Reference material you can draw on to answer general questions (do not invent facts beyond this and your persona instructions — if you don't know, say so and offer to connect them with a person). Some items include a [source: URL] — when you use one of those, casually mention where it's from or offer the link (e.g. "you can see the full details here: <url>"), so the answer feels grounded, not just asserted. Never show the [source: ...] tag itself verbatim; just describe/link it naturally:
${knowledgeBlock}

IMPORTANT about booking: never promise a "widget will appear" or "here's a link" until AFTER create_contact_and_offer_booking or assess_partner_qualification actually returns booking_available:true — the response tells you exactly what happened. If booking_available is false, say a team member will personally follow up — do not invent a scheduling mechanism that doesn't exist.

Keep replies conversational and concise (a few sentences), like a real chat, not an essay.`
                });
                const chatHistory = history.map(m => ({ role: m.role === 'bot' ? 'model' : 'user', parts: [{ text: m.text }] }));
                const chat = model.startChat({ history: chatHistory });
                let result = await chat.sendMessage(text);
                let maxIterations = 4;
                while (maxIterations-- > 0) {
                    let calls; try { calls = result.response.functionCalls(); } catch { calls = null; }
                    if (!calls || !calls.length) break;
                    const toolResponses = [];
                    for (const call of calls) {
                        const toolResult = await executeTool(call.name, call.args || {});
                        toolResponses.push({ functionResponse: { name: call.name, response: toolResult } });
                    }
                    result = await chat.sendMessage(toolResponses);
                }
                let reply = '';
                try { reply = result.response.text(); } catch { reply = ''; }
                if (!reply || !reply.trim()) reply = "Sorry, could you say that again?";

                const newMessages = [...history, { role: 'user', text, at: new Date().toISOString() }, { role: 'bot', text: reply, at: new Date().toISOString() }];
                await supabase.from('bot_conversations').update({ messages: newMessages, updated_at: new Date().toISOString() }).eq('id', convo.id);

                // Phase 4: log this exchange into HighLevel's Conversations tab
                // (Custom Conversation Provider) once we have a contact tied to
                // this conversation — the visitor's message as inbound, the
                // bot's reply as outbound. Best-effort: never blocks the reply
                // to the visitor if HighLevel logging fails.
                if (convo.hl_contact_id) {
                    // Resolve once and cache — an explicit conversationId is
                    // needed alongside contactId for some accounts (see
                    // provider_test_message diagnostics in bot-admin.js).
                    let hlConversationId = convo.hl_conversation_id || null;
                    if (!hlConversationId && bot.ghl_location_id) {
                        hlConversationId = await ghlFindOrCreateConversation(bot.ghl_location_id, convo.hl_contact_id);
                        if (hlConversationId) await supabase.from('bot_conversations').update({ hl_conversation_id: hlConversationId }).eq('id', convo.id);
                    }
                    // Awaited deliberately — a Vercel function can be frozen the
                    // instant the response is sent, so fire-and-forget here would
                    // risk silently dropping the log entirely.
                    const [inRes, outRes] = await Promise.all([
                        logProviderMessage({ contactId: convo.hl_contact_id, conversationId: hlConversationId, direction: 'inbound', body: text }),
                        logProviderMessage({ contactId: convo.hl_contact_id, conversationId: hlConversationId, direction: 'outbound', body: reply })
                    ]);
                    if (!inRes.ok) console.error('[bot-chat] provider log (inbound) failed:', inRes.error);
                    if (!outRes.ok) console.error('[bot-chat] provider log (outbound) failed:', outRes.error);
                    // Also persist the error where staff can actually see it
                    // (bot-manager), since "check Vercel logs" isn't a real
                    // diagnostic path for a non-engineer.
                    const logErr = (!inRes.ok && inRes.error) || (!outRes.ok && outRes.error) || null;
                    await supabase.from('bot_conversations').update({ last_provider_log_error: logErr }).eq('id', convo.id);
                }

                // Tells the widget to set a real 30-day cookie now that this
                // visitor has given contact info — anonymous browsing before
                // that point isn't specially remembered beyond the plain
                // visit-count tracking above.
                return ok(res, { reply, conversation_id: convo.id, booking, identified: !!convo.hl_contact_id });
            } catch (e) {
                console.error('[bot-chat] Gemini failed:', e.message);
                return bad(res, "We couldn't process that right now. Please try again shortly.");
            }
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        console.error('[bot-chat]', e.message);
        return bad(res, 'Something went wrong. Please try again.');
    }
}
