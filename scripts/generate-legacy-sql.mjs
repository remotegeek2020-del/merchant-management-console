import { readFileSync, writeFileSync } from 'fs';

const records = JSON.parse(readFileSync('/tmp/legacy_import.json', 'utf8'));

function esc(val) {
    if (val === null || val === undefined) return 'NULL';
    return "'" + String(val).replace(/'/g, "''") + "'";
}

function escDate(val) {
    if (!val) return 'NULL';
    // Accept YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return "'" + val + "'";
    return 'NULL';
}

const BATCH_SIZE = 200;
const batches = [];

for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const values = batch.map(r => {
        return `(
  gen_random_uuid(),
  ${esc(r.serial)},
  ${esc(r.tid)},
  ${esc(r.mid)},
  (SELECT id FROM merchants WHERE merchant_id = ${esc(r.mid)} LIMIT 1),
  ${escDate(r.deploymentDate)},
  ${esc(r.trackingNumber)},
  ${esc(r.notes)},
  ${esc(r.purchaseType)},
  ${esc(r.terminalType)},
  ${esc(r.terminalTypeSource)},
  'active',
  NOW(),
  'bulk_import'
)`;
    }).join(',\n');

    const sql = `INSERT INTO legacy_deployments
  (id, serial_number, tid, mid, merchant_id, deployment_date, tracking_number, notes, purchase_type, terminal_type, terminal_type_source, status, created_at, imported_by)
VALUES
${values}
ON CONFLICT DO NOTHING;`;

    batches.push(sql);
}

// Write all batches as separate files
batches.forEach((sql, idx) => {
    writeFileSync(`/tmp/legacy_batch_${String(idx).padStart(3,'0')}.sql`, sql);
});

console.log(`Generated ${batches.length} batch files (${BATCH_SIZE} rows each)`);
console.log('Files: /tmp/legacy_batch_000.sql ... /tmp/legacy_batch_' + String(batches.length-1).padStart(3,'0') + '.sql');
