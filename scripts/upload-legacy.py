#!/usr/bin/env python3
"""Uploads legacy deployment records to Supabase via REST API."""

import json, urllib.request, urllib.error, sys, time

SUPABASE_URL = "https://zuzwljjrppyrzngmhdru.supabase.co"
ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1endsampycHB5cnpuZ21oZHJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1NjI3NjQsImV4cCI6MjA4ODEzODc2NH0.C7883WzNJIyqrc5vcWrOFPPDfjq7DAZhw2oQKFpwoow"

HEADERS = {
    "apikey": ANON_KEY,
    "Authorization": f"Bearer {ANON_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal,resolution=ignore-duplicates"
}

BATCH_SIZE = 200

def rest_get(path, params=""):
    url = f"{SUPABASE_URL}/rest/v1/{path}?{params}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def rest_post(path, data):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=HEADERS, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return True, r.status
    except urllib.error.HTTPError as e:
        return False, e.read().decode()

# Load records
records = json.load(open('/tmp/legacy_import.json'))
print(f"Total records to import: {len(records)}")

# Get already-inserted serials
print("Fetching already-inserted serials...")
existing = set()
offset = 0
while True:
    chunk = rest_get("legacy_deployments", f"select=serial_number&limit=1000&offset={offset}")
    if not chunk:
        break
    for r in chunk:
        existing.add(r['serial_number'])
    if len(chunk) < 1000:
        break
    offset += 1000
print(f"Already in DB: {len(existing)}")

# Filter to only new records
new_records = [r for r in records if r['serial'] not in existing]
print(f"Records to insert: {len(new_records)}")

# Resolve MIDs → merchant UUIDs via REST
unique_mids = list({r['mid'] for r in new_records if r['mid']})
print(f"Unique MIDs to resolve: {len(unique_mids)}")

mid_map = {}
for i in range(0, len(unique_mids), 100):
    batch_mids = unique_mids[i:i+100]
    filter_val = "in.(" + ",".join(batch_mids) + ")"
    rows = rest_get("merchants", f"select=id,merchant_id&merchant_id={filter_val}&limit=200")
    for row in rows:
        mid_map[row['merchant_id']] = row['id']
    if (i // 100) % 10 == 0:
        print(f"  Resolved MIDs: {i + len(batch_mids)}/{len(unique_mids)}")

print(f"MIDs matched to merchants: {len(mid_map)}/{len(unique_mids)}")

# Build insert rows
def to_row(r):
    return {
        "serial_number": r['serial'],
        "tid": r['tid'],
        "mid": r['mid'],
        "merchant_id": mid_map.get(r['mid']) if r['mid'] else None,
        "deployment_date": r['deploymentDate'],
        "tracking_number": r['trackingNumber'],
        "notes": r['notes'],
        "purchase_type": r['purchaseType'],
        "terminal_type": r['terminalType'],
        "terminal_type_source": r['terminalTypeSource'],
        "status": "active",
        "imported_by": "bulk_import"
    }

rows_to_insert = [to_row(r) for r in new_records]

# Insert in batches
inserted = 0
errors = 0
total_batches = (len(rows_to_insert) + BATCH_SIZE - 1) // BATCH_SIZE

for i in range(0, len(rows_to_insert), BATCH_SIZE):
    batch = rows_to_insert[i:i+BATCH_SIZE]
    batch_num = i // BATCH_SIZE + 1
    ok, result = rest_post("legacy_deployments", batch)
    if ok:
        inserted += len(batch)
        if batch_num % 5 == 0 or batch_num == total_batches:
            print(f"  Batch {batch_num}/{total_batches} OK — {inserted} inserted so far")
    else:
        errors += 1
        print(f"  Batch {batch_num} FAILED: {result[:200]}")
        if errors >= 3:
            print("Too many errors, stopping.")
            break
    time.sleep(0.1)  # small delay to avoid rate limiting

print(f"\nDone. Inserted: {inserted}, Errors: {errors}")
