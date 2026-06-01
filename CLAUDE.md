# Merchant Management Console — Project Memory

## Stack
- **Frontend**: HTML/CSS/JS (vanilla), hosted on Vercel
- **Backend**: Vercel serverless functions (`api/*.js`, ES modules)
- **Database**: Supabase (PostgreSQL) — project ID `zuzwljjrppyrzngmhdru`
- **Email**: Postmark (`POSTMARK_SERVER_TOKEN`)
- **GHL (GoHighLevel)**: whitelabel at `app.mypayprotec.com`, API keys stored encrypted in `app_config` table
- **Session**: `pp_session_token` in localStorage, validated against `staff_sessions` table
- **Git**: feature branch `claude/hey-hey-hey-hey-YuBH9`, also push to `main`

## Core Principles (user-stated)
- "What we do here is healing, improving and securing, not changing the current functionalities"
- Always retain existing manual processes — add new features alongside, never replace
- No storing files in Supabase database (use GHL or external storage instead)

## Key Config
- `app_config` table stores secrets encrypted with AES-256-GCM (key = SHA-256 of `SUPABASE_SERVICE_ROLE_KEY`)
- Supabase Edge Function `ghl-media-upload` (version 3) handles GHL file uploads — uploads to "Secure Files" folder in GHL media library
- GHL notes tagged `[DOC]` are used for partner document tracking (no Supabase storage)

---

## Planned Feature: ShipStation Integration

**Status**: Planned — not yet built. User approved the approach on 2026-06-01.

### Approach
- **Keep existing manual deployment/return process 100% unchanged**
- Add a new **ShipStation tab** in the console as a separate section
- ShipStation handles label creation only — does not replace manual workflows

### 3 Shipping Modes
1. **Ship to Partner** — ship to partner's address; deployment recorded on the merchant tied to that partner; tracking from ShipStation
2. **Ship to Merchant** — ship directly to merchant's address; creates deployment record; tracking from ShipStation
3. **Custom Shipping** — custom address tied to a specific merchant

### Address Logic
- Merchant address already exists (`merchant_address`, `merchant_city`, `merchant_state`, `merchant_zip`, `merchant_country`)
- Partner (`persons`) has NO address fields yet — needs `address`, `city`, `state`, `zip`, `country` added
- If no address on file → manual entry form with "Save to record" checkbox

### New Table Needed: `shipstation_shipments`
```sql
CREATE TABLE shipstation_shipments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ss_order_id      text,
    ss_shipment_id   text,
    ss_label_url     text,
    tracking_number  text,
    carrier          text,
    service          text,
    ship_type        text, -- 'outbound' | 'return_label'
    merchant_id      uuid REFERENCES merchants(id),
    return_id        uuid REFERENCES returns(id),
    ship_to_name     text,
    address          text,
    city             text,
    state            text,
    zip              text,
    country          text DEFAULT 'US',
    status           text DEFAULT 'created', -- created / in_transit / delivered
    created_by       text,
    created_at       timestamptz DEFAULT now()
);
```

### No Changes to Existing Tables
- `deployments` — untouched
- `returns` — untouched
- Only add address fields to `persons`

### ShipStation API
- Auth: HTTP Basic (base64 of `api_key:api_secret`)
- Keys stored in `app_config` as `SHIPSTATION_API_KEY` and `SHIPSTATION_API_SECRET`
- Create order: `POST https://ssapi.shipstation.com/orders/createorder`
- Get carriers: `GET https://ssapi.shipstation.com/carriers`
- Webhook: ShipStation fires `SHIP_NOTIFY` on shipment — update `shipstation_shipments.status` + `tracking_number`

### UI Flow
1. First screen: choose **Ship to Partner / Ship to Merchant / Custom**
2. Search & select partner or merchant → auto-fill address
3. If no address → manual form + save option
4. Select equipment items from available stock
5. Pick carrier + service level (loaded from ShipStation)
6. Review → Create → get tracking number back
7. Tracking number visible from merchant record and return record

### Webhook Handler
- New endpoint: `api/shipstation-webhook.js`
- Verifies shared secret from query param or header
- Matches `ss_order_id` → updates `shipstation_shipments` status
