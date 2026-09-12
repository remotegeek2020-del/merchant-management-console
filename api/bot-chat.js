// ── Website bot — public chat endpoint (Phase 1) ─────────────────────────────
// Powers the embeddable widget (bot-widget.js). No staff session required —
// this is the public-facing surface. A bot is identified by its `slug`
// (e.g. "partner-info"), configured/managed by staff in bot-manager.html.
//
// Phase 1 scope: one bot, manually-fed knowledge (bot_knowledge rows), a
// Gemini chat loop with the bot's own persona/identity, conversation history
// kept per visitor_key (a random id the widget generates and holds for its
// session — cross-visit memory is a later phase, not built yet).
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
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

async function loadBot(slug) {
    if (!slug) return null;
    const { data } = await supabase.from('bots').select('*').eq('slug', slug).maybeSingle();
    return data;
}

async function geminiKey() {
    return process.env.GEMINI_API_KEY || (await getConfigValue('GEMINI_API_KEY')) || '';
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
            return ok(res, { bot: { name: bot.name, welcome_message: bot.welcome_message || `Hi! I'm ${bot.name}. How can I help?` } });
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

            try {
                const genAI = new GoogleGenerativeAI(key);
                const model = genAI.getGenerativeModel({
                    model: 'gemini-2.5-flash',
                    generationConfig: { temperature: 0.5 },
                    systemInstruction: `${bot.persona || 'You are a helpful assistant.'}

Reference material you can draw on to answer questions (do not invent facts beyond this and your persona instructions — if you don't know, say so and offer to connect them with a person):
${knowledgeBlock}

Keep replies conversational and concise (a few sentences), like a real chat, not an essay.`
                });
                const chatHistory = history.map(m => ({ role: m.role === 'bot' ? 'model' : 'user', parts: [{ text: m.text }] }));
                const chat = model.startChat({ history: chatHistory });
                const r = await chat.sendMessage(text);
                const reply = (r?.response?.text() || '').trim() || "Sorry, could you say that again?";

                const newMessages = [...history, { role: 'user', text, at: new Date().toISOString() }, { role: 'bot', text: reply, at: new Date().toISOString() }];
                await supabase.from('bot_conversations').update({ messages: newMessages, updated_at: new Date().toISOString() }).eq('id', convo.id);

                return ok(res, { reply, conversation_id: convo.id });
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
