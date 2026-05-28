import { readFileSync, writeFileSync } from 'fs';

const CSV_PATH = '/root/.claude/uploads/701e2717-64e4-4b38-9c74-0fc3f4529270/b23a6fb8-My_Logs.csv';

// Same prefix map as api/legacy.js — ordered most-specific first
const SERIAL_PREFIX_MAP = [
    { prefix: '118816', type: 'Z8 Terminal' },
    { prefix: '118172', type: 'Z8 Terminal' },
    { prefix: '11811',  type: 'Z11 Terminal' },
    { prefix: '1179',   type: 'Z9' },
    { prefix: '1259',   type: 'Z9' },
    { prefix: '181241', type: 'VL550' },
    { prefix: '181251', type: 'VL550' },
    { prefix: '181244', type: 'VP550' },
    { prefix: '118214', type: 'Valor VL100' },
    { prefix: '167242', type: 'VL100 Pro' },
    { prefix: '167250', type: 'VL100 Pro' },
    { prefix: '125214', type: 'Valor VL110' },
    { prefix: '310',    type: 'Valor VL300' },
    { prefix: '3026',   type: 'Z6 - Pin Pad' },
    { prefix: '3023',   type: 'Z3 - Pin Pad' },
    { prefix: '686',    type: 'DuoPricer Labler' },
    { prefix: 'Q7A',    type: 'RCKT POS' },
    { prefix: 'PQB8',   type: 'VP800 Cradle' },
    { prefix: 'X5B',    type: 'VP800' },
    { prefix: 'XC5',    type: 'VP800' },
    { prefix: 'NEBB',   type: 'VP550c' },
    { prefix: 'NDB4',   type: 'VP550' },
    { prefix: 'P18A',   type: 'Dejavoo P18' },
    { prefix: 'P17B',   type: 'Dejavoo P17' },
    { prefix: 'P16B',   type: 'Dejavoo P16' },
    { prefix: 'P8A',    type: 'Dejavoo P8' },
    { prefix: 'P1',     type: 'Dejavoo P1' },
    { prefix: 'WP',     type: 'Dejavoo QD2' },
    { prefix: '11812',  type: 'Z8 Terminal' },
    { prefix: '1181',   type: 'Z8 Terminal' },
];

function estimateTerminalType(serial) {
    if (!serial) return { type: null, source: 'unknown' };
    const s = serial.trim().toUpperCase();
    for (const { prefix, type } of SERIAL_PREFIX_MAP) {
        if (s.startsWith(prefix.toUpperCase())) return { type, source: 'estimated' };
    }
    return { type: null, source: 'unknown' };
}

function splitCSVLine(line) {
    const fields = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
            else inQuote = !inQuote;
        } else if (ch === ',' && !inQuote) {
            fields.push(cur.trim()); cur = '';
        } else {
            cur += ch;
        }
    }
    fields.push(cur.trim());
    return fields;
}

const raw = readFileSync(CSV_PATH, 'utf8');
const lines = raw.split('\n').filter(l => l.trim());

// Header: Last Modified Date, TID, Deployment Date, Serial Number, MID, Tracking Number, Notes, Purchase Type, Terminal Type
// Index:  0                   1    2                3              4    5               6      7              8

const bySerial = new Map();
let skipped = 0;

for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    const serial = (cols[3] || '').trim();
    const mid    = (cols[4] || '').trim();
    if (!serial || !mid) { skipped++; continue; }

    const lastModified = (cols[0] || '').trim();
    const existing = bySerial.get(serial);
    // Keep most recent by Last Modified Date
    if (existing && existing.lastModified >= lastModified) continue;

    const csvTerminalType = (cols[8] || '').trim();
    let terminalType, terminalTypeSource;
    if (csvTerminalType) {
        terminalType = csvTerminalType;
        terminalTypeSource = 'csv';
    } else {
        const est = estimateTerminalType(serial);
        terminalType = est.type;
        terminalTypeSource = est.source;
    }

    bySerial.set(serial, {
        lastModified,
        serial,
        mid,
        tid:          (cols[1] || '').trim() || null,
        deploymentDate: (cols[2] || '').trim() || null,
        trackingNumber: (cols[5] || '').trim() || null,
        notes:        (cols[6] || '').trim() || null,
        purchaseType: (cols[7] || '').trim() || null,
        terminalType:       terminalType || null,
        terminalTypeSource: terminalTypeSource,
    });
}

const records = [...bySerial.values()];

// Stats
const withType   = records.filter(r => r.terminalType).length;
const fromCSV    = records.filter(r => r.terminalTypeSource === 'csv').length;
const estimated  = records.filter(r => r.terminalTypeSource === 'estimated').length;
const unknown    = records.filter(r => r.terminalTypeSource === 'unknown').length;

console.log(`Total CSV rows: ${lines.length - 1}`);
console.log(`Skipped (missing serial or MID): ${skipped}`);
console.log(`Unique serials to import: ${records.length}`);
console.log(`  Terminal type from CSV: ${fromCSV}`);
console.log(`  Terminal type estimated: ${estimated}`);
console.log(`  Terminal type unknown: ${unknown}`);

// Write JSON output for SQL insertion
writeFileSync('/tmp/legacy_import.json', JSON.stringify(records, null, 2));
console.log(`\nWrote ${records.length} records to /tmp/legacy_import.json`);
