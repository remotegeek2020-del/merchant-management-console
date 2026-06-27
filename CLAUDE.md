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

**Status**: Phases 1-3 COMPLETE as of 2026-06-27. Phases 4-5 pending.

### IMPORTANT design change (2026-06-27): wizard supersedes the in-modal toggle
The Phase 2 in-modal "ship to partner first" toggle was REMOVED. New approach = a
**multi-screen wizard** gated behind a **global feature flag** (`app_settings.shipstation_ready_enabled`,
toggled in Secret Dungeon → Feature Flags tab). Flag OFF (default) = "+ New Ticket" opens the
**unchanged current modal** directly (safe fallback). Flag ON = wizard:
- Screen 1: "Create Ticket (separate from ShipStation)" → opens current modal · "Create Ticket — ShipStation Ready" → continue
- Screen 2: "Ship to Merchant" / "Ship to Partner" (partner has notify-merchant flag)
- Screen 3: form mirroring the ShipStation New Order form (Recipient: Name/Company/Country/Address1-2/City/State/Zip/Phone/Email; Order Summary: Store dropdown=vendors list, Order # auto/custom, Order Date, Paid Date, Shipping/Tax/Total Paid) + Hardware (single/bulk), TID, Deployment Date. Partner mode adds Partner lookup + Merchant lookup restricted to that partner's merchants.

### Phase status
- Phase 1: DB migration (additive columns + shipstation_shipments table + order seq) — DONE
- Phase 2: getShipInfo + create ship fields + save-back (backend KEPT, reused by wizard; in-modal UI removed) — DONE
- Phase 3: ShipStation-Ready wizard + feature flag — DONE
  - DB: `app_settings` table (key/value, non-secret), `next_ss_order_number()` fn, extra shipstation_shipments cols (store_vendor_id/store_name/order_date/paid_date/notify_merchant/ship_to_phone/email/company/partner_id/address_line2-3/shipping_paid/tax_paid/total_paid)
  - `api/app-settings.js`: get (any staff) / set (super_admin) for global flags
  - `api/deployments.js`: `getPartnerLookups`, `getPartnerMerchants`, and `create` writes a shipstation_shipments row when `payload.shipstation` present (order # auto via next_ss_order_number unless custom). NO live ShipStation API call yet — keys go in Vercel env later.
  - `deployments-dashboard.html`: ssWizardModal (3 screens), reads flag on load, "+ New Ticket" → `newTicketEntry()`
  - `secret-dungeon.html`: Feature Flags tab with the on/off toggle
- Phase 4: ShipStation-Ready returns (single-leg ship_from_type) — DONE
  - Decision: HOOK INTO existing return-initiation flow (not a standalone create). Returns always start from an existing deployed unit (deployment edit modal → processReturn → return_to_office).
  - SEPARATE flag `shipstation_returns_enabled` (independent of deployments flag).
  - `api/deployments.js` `return_to_office`: accepts `ship_from_type`/`ship_from_partner_id`/`shipstation`/save-back; sets ship_from on the returns row (bulk + single In-Transit inserts) and writes a shipstation_shipments row (`ship_type='return_label'`). Completion (else) branch untouched.
  - `deployments-dashboard.html`: when flag ON, `processReturn` opens `ssReturnModal` (ship-from merchant/partner toggle, auto-fill from merchant or auto-resolved partner, ShipStation label fields, save-back) then calls return_to_office; when OFF, identical to before.
  - `secret-dungeon.html`: second toggle in Feature Flags tab.
- Phase 5 (next): ShipStation API (order create, label, webhook) — keys added in Vercel. Backtrack/reconcile by matching ShipStation tracking number ↔ `deployments.tracking_id`.

### Vendors list = ShipStation "Store" dropdown
Reuse `api/terminal-manager` `get_vendors` (table `vendors`, returns {id,name}). Any authenticated staff can read.

### Locked-in Design Decisions (user-confirmed 2026-06-26)
- **Everything stays tied to `merchant_id`** — the deployment/return ownership never changes. We only add a *shipping destination distinction*.
- **Distinction lives on the parent `deployments`/`returns` row** (not per-item) — one destination per shipment, so single + bulk behave identically.
- **Deployments = two-leg tracking** (user chose "track both legs"): partner leg + merchant leg, derived from dates. Existing `status` enum (`Open`/`In Transit`/`Closed`) is UNTOUCHED.
  - Direct: Open → In Transit → 🏪 merchant received (`merchant_received_date`)
  - Via partner: Open → ✈️ in transit to partner → 🤝 partner received (`partner_received_date`) → 🏪 merchant installed (`merchant_received_date`)
- **Returns = single-leg** (user clarified): either merchant or partner ships back directly, always tied to merchant record. `ship_from_type` records who sent it. No second-leg date.
- **Partner is ALWAYS the merchant's own agent** — auto-resolved from `merchants.agent_id → agent_identifiers.id_string → agents.id → persons (parent_agent_id)`. No manual partner picking.
- **Entry point = INSIDE the existing New Deployment / New Return modal** (a toggle), NOT a separate tab. (Original "separate tab" plan superseded.)
- **Auto-fill + save-back for BOTH merchant & partner**: pick merchant → fills name/email/phone/address; blanks are editable; on confirm, missing values UPDATE the record.
- **Order number = distinct, customizable SS-sequence** (`SS-10001`...) via `shipstation_order_seq`, tied to deployment/return via FK. Custom override allowed. (ShipStation `orderNumber` is what we send; `orderId`/`shipmentId` are SS-internal, returned after creation.)

### Address Logic
- Merchant address/contact ALL already exist: `merchant_address/city/state/zip/country`, `dba_name`, `email`, `merchant_primary_contact`, `merchant_phone` → no merchant schema change needed.
- Partner (`persons`) already had `full_name`, `email`, `phone_number` → only address fields were added.

### Phase 1 schema APPLIED (migration `shipstation_phase1_schema`)
```sql
-- persons: + address, city, state, zip, country (country default 'US')
-- deployments: + ship_to_type text default 'merchant', ship_to_partner_id uuid→persons, partner_received_date date
-- returns: + ship_from_type text default 'merchant', ship_from_partner_id uuid→persons
-- CREATE SEQUENCE shipstation_order_seq START 10001
-- CREATE TABLE shipstation_shipments (
--   id, order_number, ss_order_id, ss_shipment_id, ss_return_id, ss_label_url,
--   tracking_number, carrier, service, ship_type ('outbound'|'return_label'),
--   merchant_id→merchants, deployment_id→deployments, return_id→returns,
--   ship_to_name, address, city, state, zip, country default 'US',
--   status default 'created', created_by, created_at )
--   + indexes on merchant_id, deployment_id, return_id, tracking_number
```

### Existing tables — only ADDITIVE columns, existing rows default to 'merchant'/'merchant'
- `deployments` / `returns` — only the additive columns above; all current logic untouched
- Manual deploy/return flow remains 100% intact

### ShipStation API
- Auth: HTTP Basic (base64 of `api_key:api_secret`)
- Keys stored in `app_config` as `SHIPSTATION_API_KEY` and `SHIPSTATION_API_SECRET`
- Create order: `POST https://ssapi.shipstation.com/orders/createorder`
- Get carriers: `GET https://ssapi.shipstation.com/carriers`
- Webhook: ShipStation fires `SHIP_NOTIFY` on shipment — update `shipstation_shipments.status` + `tracking_number`

### UI Flow (revised — toggle inside existing modal, NOT a separate tab)
1. In the existing New Deployment / New Return modal, select merchant (as today)
2. Toggle: **Ship to merchant directly** (default) vs **Ship to partner first** (deployments) / merchant-or-partner origin (returns)
3. Auto-fill name/email/phone/address from merchant (and partner via agent_id chain); blanks editable; on confirm missing values save back to the record
4. Select equipment (single or bulk — unchanged)
5. (ShipStation phase) order number auto = `SS-####` (customizable), pick carrier + service
6. Review → Create → tracking written back into existing `tracking_id` + `shipstation_shipments`
7. Dashboard shows badge 🏪 Direct / 🤝 Via [Partner]; partner-first deployments show partner-received milestone

### Webhook Handler
- New endpoint: `api/shipstation-webhook.js`
- Verifies shared secret from query param or header
- Matches `ss_order_id` → updates `shipstation_shipments` status
