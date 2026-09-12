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
// Phase 4: log the conversation as a HighLevel Note on that contact, created
//          once then updated in place as the conversation continues.
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getConfigValue } from './api-config.js';
import { ghlUpsertContact, ghlCreateNote, ghlUpdateNote } from './_ghl.js';

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

const functionDeclarations = [
    {
        name: 'lookup_partner',
        description: "Look up an existing PayProTec partner by their Partner ID to check their merchants and whether they qualify for a Prime49 upgrade. Use this ONLY when the visitor says they're already a partner and gives you an ID (or asks to check their Prime49 eligibility). Any Partner ID they own works, even if they have several.",
        parameters: { type: 'object', properties: { partner_id: { type: 'string', description: 'The Partner ID they gave you' } }, required: ['partner_id'] }
    },
    {
        name: 'create_contact_and_offer_booking',
        description: "Call this ONLY once the visitor is ready to move forward (wants to become a partner, or is an eligible existing partner ready to book) AND you have their name and at least an email or phone number. Creates/updates their record and triggers the booking widget to appear in the chat.",
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }
            },
            required: ['name']
        }
    }
];

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
            return ok(res, { bot: { name: bot.name, welcome_message: welcome }, returning, visit_count: visitCount });
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

            const { data: knowledgeRows } = await supabase.from('bot_knowledge').select('topic, content').eq('bot_id', bot.id).limit(200);
            const knowledgeBlock = (knowledgeRows || []).length
                ? (knowledgeRows || []).map(k => `- ${k.topic ? k.topic + ': ' : ''}${k.content}`).join('\n')
                : '(no reference material loaded yet — answer generally and honestly say when you do not know something specific)';

            let booking = null; // set by the tool if this turn should surface a booking widget
            async function executeTool(name, args) {
                if (name === 'lookup_partner') {
                    const r = await lookupPartner(bot, args.partner_id);
                    return r;
                }
                if (name === 'create_contact_and_offer_booking') {
                    if (!bot.ghl_location_id) return { ok: false, error: 'Booking is not configured for this assistant yet.' };
                    const r = await ghlUpsertContact(bot.ghl_location_id, { name: args.name, email: args.email, phone: args.phone }, []);
                    if (r.ok && r.id) {
                        await supabase.from('bot_conversations').update({
                            hl_contact_id: r.id, visitor_name: args.name || null, visitor_email: args.email || null, visitor_phone: args.phone || null
                        }).eq('id', convo.id);
                        convo.hl_contact_id = r.id;
                        await supabase.from('bot_visitors').update({ hl_contact_id: r.id }).eq('bot_id', bot.id).eq('visitor_key', visitorKey);
                        if (bot.booking_mode === 'form' && bot.booking_form_id) booking = { mode: 'form', form_id: bot.booking_form_id };
                        else if (bot.booking_calendar_id) booking = { mode: 'calendar', calendar_id: bot.booking_calendar_id };
                        return { ok: true };
                    }
                    return { ok: false, error: r.error || 'Could not create the contact.' };
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
                    tools: [{ functionDeclarations }],
                    systemInstruction: `${bot.persona || 'You are a helpful assistant.'}

${visitorContext}

Reference material you can draw on to answer questions (do not invent facts beyond this and your persona instructions — if you don't know, say so and offer to connect them with a person):
${knowledgeBlock}

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

                // Phase 4: log/refresh the transcript as a Note on the HighLevel
                // contact, once we have one tied to this conversation.
                if (convo.hl_contact_id && bot.ghl_location_id) {
                    const transcriptText = `Website bot conversation (${bot.name}):\n\n` + newMessages.map(m => `${m.role === 'user' ? 'Visitor' : 'Bot'}: ${m.text}`).join('\n');
                    if (convo.hl_note_id) {
                        await ghlUpdateNote(bot.ghl_location_id, convo.hl_contact_id, convo.hl_note_id, transcriptText);
                    } else {
                        const n = await ghlCreateNote(bot.ghl_location_id, convo.hl_contact_id, transcriptText);
                        if (n.ok && n.id) await supabase.from('bot_conversations').update({ hl_note_id: n.id }).eq('id', convo.id);
                    }
                }

                return ok(res, { reply, conversation_id: convo.id, booking });
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
