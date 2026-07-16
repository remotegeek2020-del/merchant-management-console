import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
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
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

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

        // ── 1b. MANAGED TERMINAL TYPES (Terminal Type Manager = source of truth) ─
        const { data: typeRows } = await supabase.from('terminal_types').select('name').eq('is_active', true);
        const managedTypes = [...new Set((typeRows || []).map(r => r.name).filter(Boolean))];
        const normT = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const managedNorm = new Map();
        managedTypes.forEach(n => { if (!managedNorm.has(normT(n))) managedNorm.set(normT(n), n); });
        // Match a raw type string to a managed type (exact, then brand-prefix stripped).
        const canonType = (raw) => {
            if (!raw) return null;
            const n = normT(raw);
            if (managedNorm.has(n)) return managedNorm.get(n);
            const noBrand = String(raw).replace(/^(dejavoo|valor|ingenico|verifone|pax|clover|first ?data|fd|nuvei)\s+/i, '');
            const n2 = normT(noBrand);
            if (n2 && n2 !== n && managedNorm.has(n2)) return managedNorm.get(n2);
            return null;
        };

        // ── 2. CALL GEMINI FOR OCR ────────────────────────────────────────
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            generationConfig: { temperature: 0 },
        });

        const prompt = `You extract hardware terminal SERIAL NUMBERS from a document for an inventory system.

STEP 1 — Classify the document:
- "invoice" / "packing_slip" / "shipment": a list of physical units being purchased or shipped, each with its own printed serial number.
- "spec_sheet" / "datasheet" / "brochure" / "manual" / "other": product information or marketing — NOT a list of units to inventory.

STEP 2 — Only if it is an invoice / packing_slip / shipment, extract EVERY real unit serial number.

STRICT RULES:
- NEVER invent, guess, autocomplete, or reformat a serial number. Output only serials literally printed in the document.
- Do NOT treat model names, SKU/part numbers, quantities, prices, dates, phone numbers, addresses, firmware versions, or specification values as serial numbers.
- One object per serial number. If a line shows quantity 5 with 5 printed serials, output 5 objects.
- For "terminal_type" you MUST choose the closest match from this EXACT list of allowed terminal types (copy the name exactly, including capitalization). If none is a clear match, use "UNKNOWN".
ALLOWED TERMINAL TYPES: ${managedTypes.join(' | ')}
- If it is NOT an invoice/packing_slip/shipment, set "is_invoice": false and return an empty "data" array. Do not extract anything.
- Return ONLY valid JSON, no markdown.

Output format:
{"is_invoice": true, "document_type": "invoice|packing_slip|shipment|spec_sheet|datasheet|brochure|manual|other", "invoice_date": "YYYY-MM-DD or null", "data": [{"serial_number": "EXACT_SERIAL", "terminal_type": "Proper Model Name"}]}`;

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
        let isInvoice = null;      // null = model didn't say; true/false = explicit
        let docType = null;

        // Layer 1: JSON parse
        try {
            const cleaned = rawText.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
            const parsed = JSON.parse(cleaned);
            if (parsed.invoice_date) invoiceDate = parsed.invoice_date;
            if (typeof parsed.is_invoice === 'boolean') isInvoice = parsed.is_invoice;
            if (parsed.document_type) docType = String(parsed.document_type);

            const rawArray = parsed.data || parsed.items || (Array.isArray(parsed) ? parsed : []);
            rawArray.forEach(item => {
                const rawSN = normalizeSN(item.serial_number || item.sn || '');
                // Real terminal serials are ≥6 chars AND contain at least one digit —
                // this drops model names / spec values the model may misread as serials.
                if (rawSN.length < 6 || !/[0-9]/.test(rawSN)) return;
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

        // If the model classified this as a non-invoice, stop here with a clear
        // message — do NOT run the regex fallback (which could false-positive).
        if (isInvoice === false) {
            const label = (docType && docType !== 'other') ? docType.replace(/_/g, ' ') : 'non-invoice document';
            return fail(422, `This looks like a ${label}, not a hardware invoice or packing list — nothing was imported. Please upload the invoice/packing slip that lists the units and their serial numbers.`);
        }

        // Layer 2: regex sweep for known serial formats (catches anything missed on a real invoice).
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
            const hint = (docType && docType !== 'invoice' && docType !== 'packing_slip' && docType !== 'shipment')
                ? ` This appears to be a ${docType.replace(/_/g,' ')}, not an invoice.`
                : ` AI response snippet: ${rawText.substring(0, 150) || 'EMPTY'}`;
            return fail(422, `No serial numbers found.${hint}`);
        }

        // ── 4a. CANONICALIZE TYPES against the Terminal Type Manager ─────
        // Never invent a type — map to a managed one, or flag as unknown so the
        // dashboard can ask the user to pick/create it.
        extracted.forEach(item => {
            const c = canonType(item.terminal_type);
            item.suggested_type = item.terminal_type || null;   // what the AI/regex thought
            item.type_known = !!c;
            item.terminal_type = c || item.terminal_type || 'UNKNOWN';
        });

        // ── 4b. CATEGORIZE AGAINST DATABASE ──────────────────────────────
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

        // Distinct types that are NOT in the manager — the UI must resolve these.
        const unknownTypes = [...new Set(newItems.filter(i => !i.type_known).map(i => i.suggested_type || i.terminal_type))];

        return res.status(200).json({
            success: true,
            document_type: docType,
            invoice_date: invoiceDate,
            new_items:   newItems,
            duplicates:  duplicates,
            total_extracted: extracted.length,
            managed_types: managedTypes,
            unknown_types: unknownTypes,
        });

    } catch (err) {
        console.error('AI Import error:', err);
        return fail(500, `AI System Error: ${err.message || err.toString()}`);
    }
}
