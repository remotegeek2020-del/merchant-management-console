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
- Phase 5: live ShipStation API — DONE 2026-06-27 (deployed; user verifies on Vercel)
  - `api/deployments.js`: `createShipstationRow`/`createShipstationReturnRow` now insert the local row THEN call `ssCreateOrder()` live (best-effort, non-blocking — deployment/return still succeeds if SS down). On success store `ss_order_id` + status 'submitted'; on API error status 'ss_error'; if keys missing status stays 'created'. Line items passed (single = 1, bulk = per unit, returns = per returned unit; sku=serial, name=terminal_type).
  - `api/shipstation-webhook.js` (NEW): receives SHIP_NOTIFY, verifies `?secret=` (env `SHIPSTATION_WEBHOOK_SECRET`), fetches resource_url via ssFetchResource, matches shipment.orderNumber → shipstation_shipments.order_number, writes tracking_number/carrier/service/ss_shipment_id/status='shipped' AND back into deployments.tracking_id. Returns 200 even on internal error (avoid retry storms).
  - `api/shipstation.js`: added `reconcile` action (pull recent GET /shipments, match orderNumber → backfill tracking). Manual backtrack for historical records.
  - **USER TODO to finish wiring:** (1) add env `SHIPSTATION_WEBHOOK_SECRET` in Vercel; (2) in ShipStation → Settings → Integrations → Webhooks, add a "On Items Shipped / SHIP_NOTIFY" webhook pointing to `https://<host>/api/shipstation-webhook?secret=<that secret>`. Until then, order creation works but tracking auto-writeback won't fire (can use the `reconcile` action instead).

### LABEL STEP DECISION (REVERSED 2026-06-27 → Phase 6 built)
Initially decided to keep labels in ShipStation, but user then chose "Path B: full in-portal
label panel" so staff never open ShipStation. Phase 6 BUILT:
- `api/shipstation.js` actions: `get_warehouses`, `get_carriers`, `list_services`,
  `list_packages`, `get_rates` (loops carriers like the Rate Browser, sorts by total cost),
  `create_label` (POST /orders/createlabelfororder → returns base64 labelData + trackingNumber;
  writes tracking/carrier/service/ss_shipment_id back to shipstation_shipments + deployments.tracking_id, status='shipped').
- `api/deployments.js` `get_ss_shipment` (returns the outbound shipstation_shipments row for a deployment).
- `deployments-dashboard.html`: `ssLabelModal` (Configure Shipment panel: Ship From/warehouses,
  weight lbs+oz, size LxWxH, confirmation, residential, insurance, carrier→services/packages,
  Browse Rates→live rate list→click to pick, Create+Print Label opens base64 PDF in new window).
  Entry = `ssLabelCheck()` called from `openEditModal`; shows "Configure Shipment & Print Label"
  button in the edit modal ONLY when `_shipstationEnabled` AND the deployment has an outbound
  shipstation_shipments row. Flag OFF → button hidden → fully reverts to old flow.
- Tracking still ALSO auto-syncs via the SHIP_NOTIFY webhook (Phase 5). Webhook registered:
  event "On Orders Shipped" → `https://portal.mypayprotec.com/api/shipstation-webhook?secret=<SHIPSTATION_WEBHOOK_SECRET>`.
- REVERSIBILITY (user priority): every ShipStation UI surface is gated on the Secret Dungeon
  flags. Turn `shipstation_ready_enabled` / `shipstation_returns_enabled` OFF → standard
  deployment/return flow returns 100%, no ShipStation UI shown anywhere.

### (historical) Phase 5 build notes
  - CONFIRMED WORKING: V1 API (`ssapi.shipstation.com`), HTTP Basic auth. Keys are in **Vercel env vars** (`SHIPSTATION_API_KEY` + `SHIPSTATION_API_SECRET`). `api/shipstation.js` `getShipStationKeys()` reads `process.env` first, falls back to `app_config`. Store dropdown VERIFIED populating live (Dejavoo, Manual Orders, New WooCommerce Store) → auth works end-to-end.
  - DONE in `api/shipstation.js`: exported `shipStationConfigured()`, `ssCreateOrder(o)` (POST /orders/createorder, maps a normalized order incl. shipTo, items, storeId→advancedOptions.storeId, amountPaid/taxAmount/shippingAmount, countryCode() maps "United States"→"US"), `ssFetchResource(url)` (for webhook resource_url). `get_stores` action live.
  - FK fix applied (DB migration `shipstation_shipments_cascade_delete`): deployment_id/return_id → ON DELETE CASCADE, partner_id → SET NULL. This fixed the "can't delete ticket" bug (shipstation_shipments FK was blocking deployment deletion).
  - Deleting a deployment ticket now ALSO cancels the ShipStation order(s): `api/deployments.js` `delete` action (step 0) gathers shipstation_shipments rows for the deployment + its returns, voids any label (`ssVoidLabelById`) then deletes the SS order (`ssDeleteOrder` → DELETE /orders/{id}). Best-effort/non-blocking — local delete still succeeds if ShipStation is down.
  - `void_label` action + "Void Label (refund)" button in ssLabelModal. Test labels: USPS/Stamps.com only (FedEx/UPS reject testLabel — guarded client-side). Email sanitized in ssCreateOrder (invalid → omitted); invalid US ZIP blocked before getrates.

  ### REMAINING Phase 5 TODO (resume here):
  1. **Import + call ssCreateOrder** in `api/deployments.js`:
     - add `import { ssCreateOrder } from './shipstation.js';` at top
     - in `createShipstationRow(deploymentId, lineItems)` (deployment create): after inserting the local shipstation_shipments row (capture its id via `.select('id').single()`), call ssCreateOrder with shipTo/items/storeId(ss.ss_store_id)/amounts, then UPDATE the row with `ss_order_id` (+ status 'submitted', or 'ss_error' on failure). Best-effort/non-blocking — deployment must still succeed if SS call fails.
     - pass line items: single = [{sku:serial, name:terminal_type, quantity:1}]; bulk = one per unit. Gather serials/types in the create flow and pass into createShipstationRow.
     - same for `createShipstationReturnRow(returnId)` in `return_to_office` (ship_type='return_label').
  2. **Create `api/shipstation-webhook.js`**: verify shared secret from `?secret=` query (env `SHIPSTATION_WEBHOOK_SECRET`); on SHIP_NOTIFY, `ssFetchResource(resource_url)` → for each shipment match `orderNumber` → our `shipstation_shipments.order_number`; UPDATE tracking_number/carrier/service/status='shipped'; also write tracking back into `deployments.tracking_id` (match via deployment_id on the row). Register this webhook URL in ShipStation settings.
  3. **Reconcile action** (backtrack existing): match ShipStation tracking number ↔ `deployments.tracking_id` to link historical records. (Lower priority.)
  - NOTE: cannot test live ShipStation calls from the dev environment (proxy + no keys locally) — user tests on Vercel after deploy.

### Push workflow (every commit this session)
`git push gh-push push-to-main && git push gh-push push-to-main:claude/hey-hey-hey-hey-YuBH9 && git push gh-push push-to-main:main` (pushes to push-to-main, feature branch, AND main).

### ShipStation wizard/returns FILES (Phases 3-5)
- `api/app-settings.js`: global flags get(any staff)/set(super_admin). Flags: `shipstation_ready_enabled`, `shipstation_returns_enabled` (both default 'false').
- `api/shipstation.js`: get_stores + exported ssCreateOrder/ssFetchResource/shipStationConfigured.
- `api/deployments.js`: getShipInfo, getPartnerLookups, getPartnerMerchants; create writes shipstation_shipments row via createShipstationRow when payload.shipstation present; return_to_office writes return_label row via createShipstationReturnRow. Order # auto via `next_ss_order_number()` rpc (SS-#### from shipstation_order_seq) unless custom.
- `deployments-dashboard.html`: `newTicketEntry()` (flag-gated), `ssWizardModal` (3 screens), `ssReturnModal` (returns ship-from), `sswLoadStoresInto()` (shared store loader). Standard modal (openNewDeploymentModal) is PRISTINE/unchanged — safe fallback when flags OFF.
- `secret-dungeon.html`: Feature Flags tab (2 toggles).

### ShipStation "Store" dropdown = LIVE ShipStation stores (NOT our vendors)
Corrected 2026-06-27: the ShipStation "Store" is a sales channel (e.g. Dejavoo, Manual Orders, WooCommerce),
distinct from our equipment `vendors`. The Store dropdown pulls live from ShipStation `GET /stores` via
`api/shipstation.js` action `get_stores` (Basic auth from `app_config` SHIPSTATION_API_KEY/SECRET).
Until the keys are added in Vercel, `get_stores` returns `{configured:false, stores:[]}` and the dropdown
shows "Add ShipStation API keys to load stores". Selected store stored as `shipstation_shipments.ss_store_id`
(ShipStation numeric storeId as text) + `store_name`. The old `store_vendor_id` column is now unused.

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

### GHL (HighLevel) partner address sync (2026-06-27)
- `persons.hl_contact_id` links each partner to a GHL contact. GHL contact has address1/city/state/postalCode/country.
- `api/_ghl.js`: `ghlGetContactAddress(id)` / `ghlUpdateContactAddress(id, addr)` — GHL v2 (`services.leadconnectorhq.com`, Bearer `GHL_API_KEY` from app_config/env, `Version: 2021-07-28`).
- PULL: `api/deployments.js` action `pull_partner_ghl` (by partner_id) returns portal + GHL address. Wizard `sswSelectPartner` and returns `ssrRenderFrom` call `ssPullPartnerGhl()` to fill empty address fields from HighLevel.
- PUSH: deployment + return save-back (doShipSaveback/doReturnSaveback) update `persons` AND push the address to the GHL contact (best-effort) so HighLevel stays in sync. Two-way gap-fill.

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
