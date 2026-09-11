// ── Prime49 SMS follow-up bot (Path B, reply handling) ───────────────────────
// Staff write the scripted opener messages (sent by cron-prime49-followup.js);
// this endpoint only runs once the lead actually replies. Wire it up as a
// HighLevel Workflow: Trigger = "Customer Replied" (inbound SMS) → Webhook
// action → this URL (campaign_id + the same per-campaign secret used for
// conversion tracking):
//
//   https://<host>/api/prime49-sms-bot?campaign_id=<id>&secret=<secret>
//
// The webhook body just needs the contact id and the inbound message text —
// HighLevel's default payload includes both ({{contact.id}}, {{message.body}}
// or similar depending on payload version; several shapes are accepted below).
//
// Gemini only ever sees ONE conversation's transcript (stored on the thread
// row, not fetched from HighLevel) and a staff-written persona/goal. It
// decides whether to keep the conversation going or hand over the booking
// link — capped at sms_bot_max_ai_replies so this can never run away.
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ghlSendSms, ghlContactSmsBlocked } from './_ghl.js';
import { getConfigValue } from './api-config.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function extractMessageText(body) {
    return body.message?.body || body.body || body.text || body.message_body || '';
}
function extractContactId(body) {
    return body.contact_id || body.contactId || (body.contact && body.contact.id) || '';
}

async function bookingLinkFor(cfg, submissionId) {
    let calendarId = cfg.survey_calendar_id, formId = cfg.survey_form_id, mode = cfg.survey_booking_mode;
    if (submissionId) {
        const { data: sub } = await supabase.from('prime49_submissions').select('assigned_rep_ghl_user_id').eq('id', submissionId).maybeSingle();
        const repId = sub && sub.assigned_rep_ghl_user_id;
        if (repId) {
            const rep = (cfg.survey_reps || []).find(r => r.ghl_user_id === repId);
            if (rep && rep.calendar_id) { calendarId = rep.calendar_id; mode = 'calendar'; }
        }
    }
    if (mode === 'form' && formId) return `https://api.leadconnectorhq.com/widget/form/${formId}`;
    if (calendarId) return `https://api.leadconnectorhq.com/widget/booking/${calendarId}`;
    return null;
}

async function assessReply(persona, transcript, bookingLink) {
    const key = process.env.GEMINI_API_KEY || (await getConfigValue('GEMINI_API_KEY')) || '';
    if (!key) return null;
    try {
        const genAI = new GoogleGenerativeAI(key);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0.6, responseMimeType: 'application/json' } });
        const convo = transcript.map(m => `${m.from === 'bot' ? 'You' : 'Lead'}: ${m.text}`).join('\n');
        const prompt = `You are texting a lead who applied to become a PayProTec payment-processing partner but hasn't booked their intro call yet.

Your persona and goal:
${persona || 'Be brief, casual, and friendly, like a real person texting — not a sales script. Your goal is to see if they are still interested and get them to book their intro call.'}

Conversation so far:
${convo}

Decide your next text. Keep it SHORT (this is SMS, 1-2 sentences max), casual, and never robotic. If they seem interested, ready, or you've built enough rapport, hand them the booking link${bookingLink ? ' (' + bookingLink + ')' : ''} and set offer_booking true. If they said stop/not interested/wrong number, write a short polite close and set offer_booking false with end_conversation true.

Return ONLY strict JSON, no markdown: {"reply": "<your text>", "offer_booking": true or false, "end_conversation": true or false}`;
        const r = await model.generateContent(prompt);
        const j = JSON.parse((r?.response?.text() || '{}').trim());
        return {
            reply: String(j.reply || '').slice(0, 480),
            offer_booking: !!j.offer_booking,
            end_conversation: !!j.end_conversation
        };
    } catch (e) {
        console.error('[prime49-sms-bot] Gemini failed:', e.message);
        return null;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const campaignId = req.query?.campaign_id;
    const provided = req.query?.secret || req.headers['x-webhook-secret'];
    if (!campaignId || !provided) return res.status(401).json({ success: false, message: 'Missing campaign_id or secret.' });

    const { data: cfg } = await supabase.from('prime49_configs').select('*').eq('campaign_id', campaignId).maybeSingle();
    if (!cfg || !cfg.webhook_secret || cfg.webhook_secret !== provided) {
        return res.status(401).json({ success: false, message: 'Invalid campaign id or secret.' });
    }
    if (!cfg.sms_bot_enabled) return res.status(200).json({ success: true, ignored: 'bot disabled' });

    try {
        let body = req.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
        body = body || {};
        const contactId = extractContactId(body);
        const messageText = String(extractMessageText(body) || '').trim();
        if (!contactId || !messageText) return res.status(200).json({ success: false, message: 'Missing contact id or message text.' });

        const { data: thread } = await supabase.from('prime49_sms_threads')
            .select('*').eq('campaign_id', campaignId).eq('hl_contact_id', contactId)
            .in('status', ['opening', 'active']).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (!thread) return res.status(200).json({ success: true, ignored: 'no active bot thread for this contact' });

        const transcript = Array.isArray(thread.transcript) ? thread.transcript : [];
        transcript.push({ from: 'lead', text: messageText, at: new Date().toISOString() });

        const maxReplies = Number.isFinite(+cfg.sms_bot_max_ai_replies) && +cfg.sms_bot_max_ai_replies > 0 ? +cfg.sms_bot_max_ai_replies : 6;
        const bookingLink = await bookingLinkFor(cfg, thread.submission_id);

        // At the reply cap: hand over the link directly, no more AI turns.
        if (thread.ai_reply_count >= maxReplies) {
            const closing = bookingLink ? `Here's the link whenever you're ready: ${bookingLink}` : `Thanks for the reply — we'll have someone follow up with you directly.`;
            if (!(await ghlContactSmsBlocked(cfg.ghl_location_id, contactId))) await ghlSendSms(cfg.ghl_location_id, contactId, closing);
            transcript.push({ from: 'bot', text: closing, at: new Date().toISOString() });
            await supabase.from('prime49_sms_threads').update({ status: 'booking_offered', transcript, next_opener_at: null, updated_at: new Date().toISOString() }).eq('id', thread.id);
            return res.status(200).json({ success: true, capped: true });
        }

        const assessment = await assessReply(cfg.sms_bot_persona, transcript, bookingLink);
        if (!assessment) return res.status(200).json({ success: false, message: 'AI assessment unavailable' });

        if (await ghlContactSmsBlocked(cfg.ghl_location_id, contactId)) {
            await supabase.from('prime49_sms_threads').update({ status: 'stopped', transcript, next_opener_at: null, updated_at: new Date().toISOString() }).eq('id', thread.id);
            return res.status(200).json({ success: true, stopped: 'sms blocked' });
        }
        await ghlSendSms(cfg.ghl_location_id, contactId, assessment.reply);
        transcript.push({ from: 'bot', text: assessment.reply, at: new Date().toISOString() });

        const newStatus = assessment.end_conversation ? 'stopped' : (assessment.offer_booking ? 'booking_offered' : 'active');
        await supabase.from('prime49_sms_threads').update({
            status: newStatus, transcript, ai_reply_count: thread.ai_reply_count + 1,
            next_opener_at: null, updated_at: new Date().toISOString()
        }).eq('id', thread.id);

        return res.status(200).json({ success: true, status: newStatus });
    } catch (e) {
        console.error('[prime49-sms-bot]', e.message);
        return res.status(200).json({ success: false, message: 'error' });
    }
}
