import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const { action, userId } = req.body;

    try {

        // ── LIST ──────────────────────────────────────────────────────────────
        if (action === 'list') {
            const { data } = await supabase
                .from('jarvis_knowledge')
                .select('id, topic, correct_logic, source, source_name, verified_by, created_at')
                .order('created_at', { ascending: false });
            return res.status(200).json({ success: true, data: data || [] });
        }

        // ── DELETE ────────────────────────────────────────────────────────────
        if (action === 'delete') {
            const { id } = req.body;
            if (!id) return res.status(400).json({ success: false, message: 'id required' });
            await supabase.from('jarvis_knowledge').delete().eq('id', id);
            return res.status(200).json({ success: true });
        }

        // ── MANUAL INJECT ─────────────────────────────────────────────────────
        if (action === 'manual') {
            const { topic, logic } = req.body;
            if (!topic || !logic) return res.status(400).json({ success: false, message: 'topic and logic required' });
            await supabase.from('jarvis_knowledge').insert({
                topic, correct_logic: logic, source: 'manual', verified_by: userId
            });
            return res.status(200).json({ success: true });
        }

        // ── INGEST TEXT (from document) ───────────────────────────────────────
        if (action === 'ingest_text') {
            const { text, source_name } = req.body;
            if (!text) return res.status(400).json({ success: false, message: 'text required' });
            if (!process.env.GEMINI_API_KEY) return res.status(500).json({ success: false, message: 'GEMINI_API_KEY missing' });

            const chunks = await extractKnowledgeChunks(text, source_name || 'document');
            if (!chunks.length) return res.status(200).json({ success: true, inserted: 0, message: 'No useful knowledge extracted' });

            await supabase.from('jarvis_knowledge').insert(
                chunks.map(c => ({ topic: c.topic, correct_logic: c.logic, source: 'document', source_name: source_name || 'Uploaded document', verified_by: userId }))
            );
            return res.status(200).json({ success: true, inserted: chunks.length, chunks });
        }

        // ── INGEST URL ────────────────────────────────────────────────────────
        if (action === 'ingest_url') {
            const { url } = req.body;
            if (!url) return res.status(400).json({ success: false, message: 'url required' });
            if (!process.env.GEMINI_API_KEY) return res.status(500).json({ success: false, message: 'GEMINI_API_KEY missing' });

            // Fetch and strip HTML
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            let rawText;
            try {
                const fetchRes = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JarvisBot/1.0)' } });
                clearTimeout(timeout);
                if (!fetchRes.ok) return res.status(400).json({ success: false, message: `URL returned ${fetchRes.status}` });
                const html = await fetchRes.text();
                rawText = stripHtml(html);
            } catch (e) {
                clearTimeout(timeout);
                return res.status(400).json({ success: false, message: `Could not fetch URL: ${e.message}` });
            }

            if (rawText.length < 100) return res.status(400).json({ success: false, message: 'Page content too short or empty' });

            const hostname = new URL(url).hostname;
            const chunks = await extractKnowledgeChunks(rawText.slice(0, 30000), hostname);
            if (!chunks.length) return res.status(200).json({ success: true, inserted: 0, message: 'No useful knowledge extracted from page' });

            await supabase.from('jarvis_knowledge').insert(
                chunks.map(c => ({ topic: c.topic, correct_logic: c.logic, source: 'url', source_name: url, verified_by: userId }))
            );
            return res.status(200).json({ success: true, inserted: chunks.length, chunks });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });

    } catch (err) {
        console.error('[Jarvis Ingest Error]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function stripHtml(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

async function extractKnowledgeChunks(text, sourceName) {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are extracting structured business knowledge for an AI assistant called JARVIS that helps manage a payment processing company (PayProTec).

From the following text, extract 3-10 distinct, useful pieces of business knowledge, rules, policies, or factual information. Focus on things that would help JARVIS give better advice about merchants, partners, deployments, inventory, and returns.

For each piece of knowledge, output a JSON array like this:
[
  { "topic": "Short topic label", "logic": "The actual knowledge, rule, or fact in 1-3 sentences." },
  ...
]

Only output the JSON array, nothing else. If there is no useful business knowledge in the text, return an empty array [].

Text from "${sourceName}":
${text}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();

    // Extract JSON array from response
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    return JSON.parse(match[0]);
}
