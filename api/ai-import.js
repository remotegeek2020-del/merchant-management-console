import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
    api: { bodyParser: { sizeLimit: '10mb' } },
};

const SERIAL_PATTERNS = [
    { regex: /P125\d{10,13}/g,      type: "Dejavoo P1"  },
    { regex: /P325\d{10,13}/g,      type: "Dejavoo P3"  },
    { regex: /P524\d{10,13}/g,      type: "Dejavoo P5"  },
    { regex: /P17[B86]\d{10,13}/g,  type: "Dejavoo P17" },
    { regex: /18125\d{7}/g,         type: "Valor VL550" },
    { regex: /18126\d{7}/g,         type: "Valor VL100" },
    { regex: /18127\d{7}/g,         type: "Valor VL110" },
    { regex: /X5C8[A-Z0-9]{8,12}/g, type: "Valor VP800" },
];

const MODEL_NAME_MAP = {
    'KOZ-P1': 'Dejavoo P1',  'KOZP1': 'Dejavoo P1',
    'KOZ-P3': 'Dejavoo P3',  'KOZP3': 'Dejavoo P3',
    'KOZ-P5': 'Dejavoo P5',  'KOZP5': 'Dejavoo P5',
    'KOZ-P17':'Dejavoo P17', 'KOZP17':'Dejavoo P17',
    'KOZ-Z11':'Dejavoo Z11', 'KOZZ11':'Dejavoo Z11',
    'KOZ-Z9': 'Dejavoo Z9',  'KOZZ9': 'Dejavoo Z9',
    'VL550':  'Valor VL550', 'VL100': 'Valor VL100',
    'VL110':  'Valor VL110', 'VP800': 'Valor VP800',
};

function normalizeModel(raw) {
    if (!raw) return 'Terminal';
    const key = raw.toUpperCase().replace(/\s+/g, '');
    return MODEL_NAME_MAP[key] || raw;
}

function normalizeSN(sn) {
    return String(sn || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
}

// If Gemini concatenates serials, split them using known patterns
function expandItem(item) {
    const sn = item.serial_number;
    for (const p of SERIAL_PATTERNS) {
        const re = new RegExp(p.regex.source, p.regex.flags);
        const matches = sn.match(re);
        if (matches && matches.length > 1) {
            return matches.map(m => ({ serial_number: m, terminal_type: item.terminal_type || p.type }));
        }
    }
    return [item];
}

export default async function handler(req, res) {
    const fail = (status, message) => res.status(status).json({ success: false, message });

    if (req.method !== 'POST') return fail(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY)  return fail(500, 'GEMINI_API_KEY not configured');
    if (!process.env.SUPABASE_URL)    return fail(500, 'Supabase not configured');

    const { fileBase64 } = req.body;
    if (!fileBase64) return fail(400, 'No file data received');

    try {
        // ── 1. FETCH EXISTING SERIALS FROM DATABASE ──────────────────────
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        // Paginate to get all serials — Supabase default cap is 1000 rows
        let existingRows = [];
        let from = 0;
        const PAGE = 1000;
        while (true) {
            const { data, error: dbError } = await supabase
                .from('equipments')
                .select('serial_number')
                .range(from, from + PAGE - 1);
            if (dbError) return fail(500, `Database error: ${dbError.message}`);
            if (!data || data.length === 0) break;
            existingRows = existingRows.concat(data);
            if (data.length < PAGE) break;
            from += PAGE;
        }

        const existingSet = new Set(existingRows.map(r => normalizeSN(r.serial_number)));

        // ── 2. CALL GEMINI FOR OCR ────────────────────────────────────────
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            generationConfig: { temperature: 0 },
        });

        const prompt = `You are an OCR tool reading a hardware invoice.

TASK: Extract every serial number found in this document.

CRITICAL RULES:
1. Create ONE separate object per serial number — never combine multiple serials into one entry.
2. If a line shows quantity 5, there should be 5 separate entries with 5 different serial numbers.
3. Map SKU codes to proper names: KOZ-P1=Dejavoo P1, KOZ-P3=Dejavoo P3, KOZ-P5=Dejavoo P5, KOZ-P17=Dejavoo P17, KOZ-Z11=Dejavoo Z11, KOZ-Z9=Dejavoo Z9.
4. Find the invoice date in YYYY-MM-DD format.
5. Return ONLY valid JSON, no markdown.

Output format:
{"invoice_date": "YYYY-MM-DD", "data": [{"serial_number": "EXACT_SERIAL", "terminal_type": "Proper Model Name"}]}`;

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('VERCEL_TIMEOUT')), 55000)
        );

        let rawText = '';
        try {
            const result = await Promise.race([
                model.generateContent([
                    { text: prompt },
                    { inlineData: { data: fileBase64, mimeType: 'application/pdf' } }
                ]),
                timeoutPromise
            ]);
            const response = await result.response;
            rawText = response.text().trim();
        } catch (err) {
            if (err.message === 'VERCEL_TIMEOUT') {
                return fail(504, 'AI timed out. Try uploading one page at a time or convert to JPG.');
            }
            throw err;
        }

        // ── 3. PARSE AI RESPONSE ─────────────────────────────────────────
        const extracted = [];
        const seenSNs  = new Set();
        let invoiceDate = null;

        // Layer 1: JSON parse
        try {
            const parsed = JSON.parse(rawText);
            if (parsed.invoice_date) invoiceDate = parsed.invoice_date;

            const rawArray = parsed.data || parsed.items || (Array.isArray(parsed) ? parsed : []);
            rawArray.forEach(item => {
                const rawSN = normalizeSN(item.serial_number || item.sn || '');
                if (rawSN.length < 6) return;
                const model_ = normalizeModel(item.terminal_type || item.type || item.model);
                expandItem({ serial_number: rawSN, terminal_type: model_ }).forEach(e => {
                    if (!seenSNs.has(e.serial_number)) {
                        extracted.push(e);
                        seenSNs.add(e.serial_number);
                    }
                });
            });
        } catch {
            console.warn('Layer 1 JSON parse failed — using regex fallback');
        }

        // Layer 2: regex sweep (always runs to catch anything missed)
        const upperText = rawText.toUpperCase();
        SERIAL_PATTERNS.forEach(p => {
            const re = new RegExp(p.regex.source, p.regex.flags);
            let m;
            while ((m = re.exec(upperText)) !== null) {
                if (!seenSNs.has(m[0])) {
                    extracted.push({ serial_number: m[0], terminal_type: p.type });
                    seenSNs.add(m[0]);
                }
            }
        });

        if (extracted.length === 0) {
            return fail(422, `No serial numbers found. AI response snippet: ${rawText.substring(0, 150) || 'EMPTY'}`);
        }

        // ── 4. CATEGORIZE AGAINST DATABASE ───────────────────────────────
        const newItems   = [];
        const duplicates = [];

        extracted.forEach(item => {
            const normalized = normalizeSN(item.serial_number);
            if (existingSet.has(normalized)) {
                duplicates.push(item);
            } else {
                newItems.push({ ...item, received_date: invoiceDate });
            }
        });

        return res.status(200).json({
            success: true,
            invoice_date: invoiceDate,
            new_items:   newItems,
            duplicates:  duplicates,
            total_extracted: extracted.length,
        });

    } catch (err) {
        console.error('AI Import error:', err);
        return fail(500, `AI System Error: ${err.message || err.toString()}`);
    }
}
