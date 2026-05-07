import { GoogleGenerativeAI } from "@google/generative-ai";

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '10mb',
        },
    },
};

// Serial patterns used in both splitting and Layer 2 harvesting
const SERIAL_PATTERNS = [
    { regex: /P125\d{10,13}/g,       type: "Dejavoo P1"  },
    { regex: /P325\d{10,13}/g,       type: "Dejavoo P3"  },
    { regex: /P524\d{10,13}/g,       type: "Dejavoo P5"  },
    { regex: /P17[B86]\d{10,13}/g,   type: "Dejavoo P17" },
    { regex: /18125\d{7}/g,          type: "Valor VL550" },
    { regex: /X5C8[A-Z0-9]{8,12}/g,  type: "Valor VP800" },
    { regex: /18126\d{7}/g,          type: "Valor VL100" },
    { regex: /18127\d{7}/g,          type: "Valor VL110" },
];

// Invoice SKU codes → proper product names
const MODEL_NAME_MAP = {
    'KOZ-P1':  'Dejavoo P1',  'KOZP1':  'Dejavoo P1',
    'KOZ-P3':  'Dejavoo P3',  'KOZP3':  'Dejavoo P3',
    'KOZ-P5':  'Dejavoo P5',  'KOZP5':  'Dejavoo P5',
    'KOZ-P17': 'Dejavoo P17', 'KOZP17': 'Dejavoo P17',
    'KOZ-Z11': 'Dejavoo Z11', 'KOZZ11': 'Dejavoo Z11',
    'KOZ-Z9':  'Dejavoo Z9',  'KOZZ9':  'Dejavoo Z9',
    'VL550':   'Valor VL550',
    'VL100':   'Valor VL100',
    'VL110':   'Valor VL110',
    'VP800':   'Valor VP800',
};

function normalizeModelName(raw) {
    if (!raw) return 'Terminal';
    const key = raw.toUpperCase().replace(/\s+/g, '');
    return MODEL_NAME_MAP[key] || raw;
}

// If a "serial_number" is actually multiple serials concatenated, split them.
// Returns an array of individual { serial_number, terminal_type } objects.
function expandItem(item) {
    const sn = item.serial_number;
    for (const p of SERIAL_PATTERNS) {
        const clone = new RegExp(p.regex.source, p.regex.flags);
        const matches = sn.match(clone);
        if (matches && matches.length > 1) {
            // Concatenated serials — split into individual items
            return matches.map(m => ({
                serial_number: m,
                terminal_type: item.terminal_type || p.type,
            }));
        }
    }
    return [item];
}

export default async function handler(req, res) {
    const sendJsonError = (status, message, details = null) =>
        res.status(status).json({ success: false, message, details });

    if (req.method !== 'POST') return sendJsonError(405, 'Method Not Allowed');
    if (!process.env.GEMINI_API_KEY) return sendJsonError(500, 'API Key Missing');

    try {
        const { fileBase64 } = req.body;
        if (!fileBase64) return sendJsonError(400, 'No file data received.');

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            generationConfig: {
                temperature: 0,
            }
        });

        const prompt = `You are an OCR tool reading a hardware invoice.

TASK: Extract every serial number found in this document.

CRITICAL RULES:
1. Create ONE separate object for EACH individual serial number — never combine multiple serials into one entry.
2. If a line item has a quantity of 5, there should be 5 separate entries with 5 different serial numbers.
3. Map invoice SKU codes to proper names: KOZ-P1=Dejavoo P1, KOZ-P3=Dejavoo P3, KOZ-P5=Dejavoo P5, KOZ-P17=Dejavoo P17, KOZ-Z11=Dejavoo Z11, KOZ-Z9=Dejavoo Z9.
4. Find the invoice date in YYYY-MM-DD format.
5. Return ONLY valid JSON — no markdown, no explanation.

Required output format:
{"invoice_date": "YYYY-MM-DD", "data": [{"serial_number": "EXACT_SERIAL", "terminal_type": "Proper Model Name"}]}`;

        // Watchdog: 8.8 seconds before Vercel's 10s kill
        const aiRequest = model.generateContent([
            { text: prompt },
            { inlineData: { data: fileBase64, mimeType: "application/pdf" } }
        ]);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('VERCEL_TIMEOUT')), 8800)
        );

        let rawText = "";
        try {
            const result = await Promise.race([aiRequest, timeoutPromise]);
            const response = await result.response;
            rawText = response.text().trim();
        } catch (err) {
            if (err.message === 'VERCEL_TIMEOUT') {
                return sendJsonError(504, "Connection timed out. For large invoices, upload one page at a time or use a JPG image.");
            }
            throw err;
        }

        const items = [];
        const seenSerials = new Set();
        let invoiceDate = null;

        // --- LAYER 1: JSON PARSE ---
        try {
            const parsed = JSON.parse(rawText);
            const rawArray = parsed.data || parsed.items || (Array.isArray(parsed) ? parsed : []);
            if (parsed.invoice_date) invoiceDate = parsed.invoice_date;

            rawArray.forEach(item => {
                const rawSN = String(item.serial_number || item.sn || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
                if (rawSN.length < 6) return;

                const modelName = normalizeModelName(item.terminal_type || item.type || item.model);
                const expanded = expandItem({ serial_number: rawSN, terminal_type: modelName });

                expanded.forEach(e => {
                    if (!seenSerials.has(e.serial_number)) {
                        items.push(e);
                        seenSerials.add(e.serial_number);
                    }
                });
            });
        } catch (e) {
            console.warn("Layer 1 JSON parse failed — falling through to regex harvester");
        }

        // --- LAYER 2: REGEX HARVESTER (always runs to catch anything Layer 1 missed) ---
        const upperText = rawText.toUpperCase();
        SERIAL_PATTERNS.forEach(p => {
            const clone = new RegExp(p.regex.source, p.regex.flags);
            let match;
            while ((match = clone.exec(upperText)) !== null) {
                const sn = match[0];
                if (!seenSerials.has(sn)) {
                    items.push({ serial_number: sn, terminal_type: p.type });
                    seenSerials.add(sn);
                }
            }
        });

        if (items.length === 0) {
            const snippet = rawText.substring(0, 150) || "EMPTY";
            return sendJsonError(422, `No serial numbers identified. AI response: ${snippet}`);
        }

        return res.status(200).json({ success: true, data: items, invoice_date: invoiceDate });

    } catch (err) {
        console.error("AI Import Exception:", err);
        return sendJsonError(500, `AI System Error: ${err.message || err.toString()}`);
    }
}
