/*
 * ss-deploy-wizard.js
 * ------------------------------------------------------------------
 * Self-contained, reusable "ShipStation-Ready" NEW DEPLOYMENT wizard.
 *
 * Extracted verbatim (behavior-preserving) from deployments-dashboard.html
 * so the same 3-screen wizard can be embedded on any page.
 *
 * Usage:
 *     <script src="/js/ss-deploy-wizard.js"></script>
 *     SSDeployWizard.open({
 *         prefillMerchant: { id, name, code },   // optional
 *         ticketId: 123,                          // optional (passthrough)
 *         mode: 'both',                           // optional; else fetched from /api/app-settings
 *         onStandard: () => {...},                // called when the "Create Ticket" (non-SS) path is chosen / mode disabled
 *         onCreated: (newDeploymentId) => {...}   // called after a successful create
 *     });
 *
 * Page-specific couplings from the original were replaced:
 *   - openNewDeploymentModal()      -> _wizOpts.onStandard?.()  (+ hides the wizard)
 *   - fetchDeployments()            -> removed (host refreshes)
 *   - ssOpenLabelForDeployment(id)  -> _wizOpts.onCreated?.(id)
 *   - authHeaders / esc / fmtDateInput / closeModal -> defined locally below
 *
 * The injected modal HTML uses inline on* handlers, so every function it
 * references is attached to window (see the export block at the bottom).
 * ------------------------------------------------------------------
 */
(function () {
    'use strict';

    if (window.SSDeployWizard) return; // already loaded

    // ─────────────────────────── local helpers (replace page globals) ───────────────────────────
    function authHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (localStorage.getItem('pp_session_token') || '')
        };
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Returns YYYY-MM-DD for <input type="date">. Reuses the host's fmtDateInput
    // (from tz.js) when present so timezone handling matches; otherwise a safe fallback.
    function fmtDateInput(d) {
        if (typeof window.fmtDateInput === 'function' && window.fmtDateInput !== fmtDateInput) {
            return window.fmtDateInput(d);
        }
        if (!d) return '';
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
        try { return new Date(d).toLocaleDateString('en-CA'); }
        catch (e) { return new Date(d).toISOString().split('T')[0]; }
    }

    // Hide a suggestion box after a short blur delay (matches the original trkHide).
    function trkHide(boxId) {
        setTimeout(function () { var b = document.getElementById(boxId); if (b) b.style.display = 'none'; }, 180);
    }

    // Backdrop close — only defined if the host page hasn't already got one.
    if (!window.closeModal) {
        window.closeModal = function (e, id) {
            if (e && e.target && e.target.id === id) {
                var el = document.getElementById(id);
                if (el) el.style.display = 'none';
            }
        };
    }

    // ─────────────────────────── module state ───────────────────────────
    var _wizOpts = {};
    var _ssReadyMode = 'disabled';   // 'disabled' | 'coming_soon' | 'ss_only' | 'both'
    var _modeCached = null;          // caches the fetched app-settings mode
    var _ssMode = 'merchant';        // 'merchant' | 'partner'
    var _ssDepMode = 'single';       // 'single' | 'bulk'
    var _ssBulkItems = [];
    var _ssMerchant = null;
    var _ssPartner = null;
    var _ssMerchantPartner = null;   // partner auto-resolved from the merchant (for "use partner email")
    var _ssBranches = [];            // additional branch merchants sharing one consolidated box
    var _ssLookupTimer = null;
    window._ssBranches = _ssBranches; // inline branch handlers reference this as a global

    // ─────────────────────────── CSS ───────────────────────────
    var WIZ_CSS = `
        #ssWizardModal.modal-backdrop { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:100050; align-items:center; justify-content:center; }
        .swal2-container { z-index:100070 !important; }  /* keep validation/success popups above the wizard */
        #ssWizardModal .modal-content { background:white; width:550px; border-radius:16px; padding:30px; position:relative; max-height:95vh; overflow-y:auto; box-shadow:0 20px 50px rgba(0,0,0,0.2); }
        #ssWizardModal .close-btn { position:absolute; top:20px; right:20px; cursor:pointer; color:#64748b; }
        #ssWizardModal .suggestions-list { position:absolute; z-index:100060; background:white; width:100%; border:1px solid var(--border,#e2e8f0); border-radius:8px; max-height:200px; overflow-y:auto; display:none; box-shadow:var(--shadow-md,0 6px 18px rgba(0,0,0,.12)); margin-top:5px; }
        #ssWizardModal .suggestion-item { padding:12px; cursor:pointer; border-bottom:1px solid #f1f5f9; font-size:13px; }
        #ssWizardModal .suggestion-item:hover { background:#f0f7ff; color:var(--pp-blue,#004990); font-weight:600; }
        /* Shipping destination toggle */
        #ssWizardModal .ship-toggle-btn { flex:1; border-radius:8px; border:1px solid #cbd5e1; background:white; color:#64748b; font-weight:700; font-size:11px; padding:8px; cursor:pointer; transition:all .15s; }
        #ssWizardModal .ship-toggle-active { background:var(--pp-blue,#004990); color:white; border-color:var(--pp-blue,#004990); }
        #ssWizardModal .ship-lbl { display:block; font-weight:700; font-size:9px; color:#94a3b8; text-transform:uppercase; letter-spacing:.4px; margin-bottom:3px; }
        #ssWizardModal .ship-in { font-size:12px !important; padding:6px 10px !important; }
        /* ShipStation wizard cards */
        #ssWizardModal .ssw-card { display:flex; flex-direction:column; align-items:flex-start; gap:6px; text-align:left; padding:18px; border:1.5px solid #e2e8f0; border-radius:14px; background:white; cursor:pointer; transition:all .15s; }
        #ssWizardModal .ssw-card:hover { border-color:#7c3aed; background:#faf5ff; transform:translateY(-1px); box-shadow:0 4px 14px rgba(124,58,237,.12); }
        #ssWizardModal .ssw-card-accent { border-color:#ddd6fe; background:#faf5ff; }
        #ssWizardModal .ssw-card-title { font-size:14px; font-weight:800; color:#002d5a; }
        #ssWizardModal .ssw-card-sub { font-size:11px; color:#94a3b8; line-height:1.35; }
        #ssWizardModal .ssw-back { background:none; border:none; color:#64748b; font-size:12px; font-weight:700; cursor:pointer; padding:0; }
        #ssWizardModal .ssw-back:hover { color:#004990; }
        /* SLDS fallbacks (identical class names) so the wizard renders standalone */
        #ssWizardModal .slds-input, #ssWizardModal .slds-select, #ssWizardModal .slds-textarea {
            width:100%; box-sizing:border-box; border:1px solid #dddbda; border-radius:6px; padding:8px 12px;
            font-size:13px; font-family:inherit; color:#16325c; background:#fff; line-height:1.4;
        }
        #ssWizardModal .slds-input:focus, #ssWizardModal .slds-select:focus, #ssWizardModal .slds-textarea:focus {
            outline:none; border-color:var(--pp-blue,#1589ee); box-shadow:0 0 3px var(--pp-blue,#1589ee);
        }
        #ssWizardModal .slds-textarea { resize:vertical; }
        #ssWizardModal .slds-button {
            display:inline-block; border:1px solid #dddbda; border-radius:6px; padding:8px 16px; font-size:13px;
            font-weight:700; font-family:inherit; cursor:pointer; background:#fff; color:#0070d2; line-height:1.4;
        }
        #ssWizardModal .slds-button_brand { background:var(--pp-blue,#0070d2); color:#fff; border-color:var(--pp-blue,#0070d2); }
        #ssWizardModal .slds-size_1-of-1 { width:100%; }
    `;

    // ─────────────────────────── Modal HTML (copied verbatim from deployments-dashboard.html) ───────────────────────────
    var WIZ_HTML = `
<div id="ssWizardModal" class="modal-backdrop" onclick="closeModal(event, 'ssWizardModal')">
    <div class="modal-content" onclick="event.stopPropagation()" style="max-width:760px;">
        <span class="material-icons close-btn" onclick="document.getElementById('ssWizardModal').style.display='none'">close</span>

        <!-- SCREEN 1: choose ticket type -->
        <div id="sswScreen1" class="ssw-screen">
            <h2 style="font-size:1.4rem; font-weight:800; color:#002d5a; margin-bottom:4px;">New Deployment Ticket</h2>
            <p style="font-size:12px; color:#94a3b8; margin-bottom:18px;">Choose how you want to create this ticket.</p>
            <div id="sswScreen1Cards" style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
                <button type="button" id="sswCardStandard" class="ssw-card" onclick="sswOpenLegacyModal()">
                    <span class="material-icons" style="font-size:30px; color:#64748b;">edit_note</span>
                    <div class="ssw-card-title">Create Ticket</div>
                    <div class="ssw-card-sub">Separate from ShipStation — opens the standard deployment form</div>
                </button>
                <button type="button" id="sswCardSS" class="ssw-card ssw-card-accent" onclick="sswGoScreen(2)">
                    <span class="material-icons" style="font-size:30px; color:#7c3aed;">local_shipping</span>
                    <div class="ssw-card-title">Create Ticket — ShipStation Ready <span id="sswComingSoonBadge" style="display:none; background:#fef3c7; color:#92400e; font-size:10px; font-weight:800; padding:2px 7px; border-radius:99px; vertical-align:middle; margin-left:4px;">COMING SOON</span></div>
                    <div class="ssw-card-sub" id="sswCardSSsub">Integrated with ShipStation order details</div>
                </button>
            </div>
        </div>

        <!-- SCREEN 2: ship destination -->
        <div id="sswScreen2" class="ssw-screen" style="display:none;">
            <button type="button" class="ssw-back" onclick="sswGoScreen(1)"><span class="material-icons" style="font-size:15px;vertical-align:-3px;">arrow_back</span> Back</button>
            <h2 style="font-size:1.4rem; font-weight:800; color:#002d5a; margin:8px 0 4px;">Where is this shipping?</h2>
            <p style="font-size:12px; color:#94a3b8; margin-bottom:18px;">ShipStation-Ready deployment.</p>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
                <button type="button" class="ssw-card" onclick="sswStart('merchant')">
                    <span class="material-icons" style="font-size:30px; color:#166534;">storefront</span>
                    <div class="ssw-card-title">Ship to Merchant</div>
                    <div class="ssw-card-sub">Ships directly to the merchant</div>
                </button>
                <button type="button" class="ssw-card" onclick="sswStart('partner')">
                    <span class="material-icons" style="font-size:30px; color:#004990;">handshake</span>
                    <div class="ssw-card-title">Ship to Partner</div>
                    <div class="ssw-card-sub">Ships to the partner, with option to notify the merchant</div>
                </button>
            </div>
        </div>

        <!-- SCREEN 3: the form -->
        <div id="sswScreen3" class="ssw-screen" style="display:none;">
            <button type="button" class="ssw-back" onclick="sswGoScreen(2)"><span class="material-icons" style="font-size:15px;vertical-align:-3px;">arrow_back</span> Back</button>
            <h2 id="sswFormTitle" style="font-size:1.3rem; font-weight:800; color:#002d5a; margin:8px 0 14px;">ShipStation Order</h2>

            <form id="sswForm" onsubmit="sswSubmit(event)">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">

                <!-- LEFT: recipient + hardware -->
                <div>
                    <!-- Partner lookup (partner mode only) -->
                    <div id="sswPartnerLookupWrap" style="display:none; position:relative; margin-bottom:12px;">
                        <label class="ship-lbl">Partner</label>
                        <input type="text" id="ssw_partnerSearch" class="slds-input ship-in" placeholder="Search partner / company / agent ID..." autocomplete="off" oninput="sswPartnerSearch(this.value)">
                        <input type="hidden" id="ssw_partnerId">
                        <div id="ssw_partnerSuggest" class="suggestions-list"></div>
                    </div>

                    <!-- Merchant lookup -->
                    <div style="position:relative; margin-bottom:12px;">
                        <label class="ship-lbl" id="sswMerchantLbl">Merchant *</label>
                        <input type="text" id="ssw_merchantSearch" class="slds-input ship-in" placeholder="Search merchant..." autocomplete="off" oninput="sswMerchantSearch(this.value)">
                        <input type="hidden" id="ssw_merchantId">
                        <div id="ssw_merchantSuggest" class="suggestions-list"></div>
                        <div id="ssw_merchantTie" style="display:none; font-size:11px; color:#0369a1; font-weight:700; margin-top:5px; background:#f0f9ff; border:1px solid #bae6fd; border-radius:6px; padding:4px 8px;"></div>
                    </div>

                    <div style="font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;margin:6px 0 8px;border-top:1px solid #eef2f7;padding-top:10px;">Recipient Information</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                        <div style="grid-column:1/-1;"><label class="ship-lbl">Name *</label><input type="text" id="ssw_name" class="slds-input ship-in" placeholder="Name"></div>
                        <div style="grid-column:1/-1;"><label class="ship-lbl">Company</label><input type="text" id="ssw_company" class="slds-input ship-in" placeholder="Company name"></div>
                        <div style="grid-column:1/-1;"><label class="ship-lbl">Country</label><input type="text" id="ssw_country" class="slds-input ship-in" value="United States"></div>
                        <div style="grid-column:1/-1;"><label class="ship-lbl">Address *</label><input type="text" id="ssw_addr1" class="slds-input ship-in" placeholder="Address Line 1"></div>
                        <div style="grid-column:1/-1;"><input type="text" id="ssw_addr2" class="slds-input ship-in" placeholder="Address Line 2"></div>
                        <div><label class="ship-lbl">City *</label><input type="text" id="ssw_city" class="slds-input ship-in" placeholder="City"></div>
                        <div><label class="ship-lbl">State *</label><input type="text" id="ssw_state" class="slds-input ship-in" placeholder="State"></div>
                        <div><label class="ship-lbl">Zip *</label><input type="text" id="ssw_zip" class="slds-input ship-in" placeholder="Zip"></div>
                        <div><label class="ship-lbl">Phone *</label><input type="text" id="ssw_phone" class="slds-input ship-in" placeholder="Phone"></div>
                        <div style="grid-column:1/-1;">
                            <label class="ship-lbl">Email *</label>
                            <input type="text" id="ssw_email" class="slds-input ship-in" placeholder="Email">
                            <label id="ssw_usePartnerEmailWrap" style="display:none; align-items:center; gap:6px; font-size:11px; color:#475569; margin-top:5px; cursor:pointer;">
                                <input type="checkbox" id="ssw_usePartnerEmail" onchange="sswTogglePartnerEmail()">
                                Use partner's email for tracking notifications <span id="ssw_usePartnerEmailHint" style="color:#94a3b8;"></span>
                            </label>
                        </div>
                    </div>

                    <label style="display:flex; align-items:center; gap:6px; font-size:11px; color:#475569; margin-top:8px; cursor:pointer;">
                        <input type="checkbox" id="ssw_saveBack" checked>
                        Save added / edited details back to the <span id="ssw_saveBackTarget" style="font-weight:700;">record</span>
                    </label>
                    <label id="ssw_notifyWrap" style="display:none; align-items:center; gap:6px; font-size:11px; color:#475569; margin-top:6px; cursor:pointer;">
                        <input type="checkbox" id="ssw_notify"> Notify the merchant about this shipment
                    </label>
                </div>

                <!-- RIGHT: hardware + order summary -->
                <div>
                    <div style="font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;margin:0 0 8px;">Hardware</div>
                    <div style="display:flex; gap:8px; margin-bottom:10px;">
                        <button type="button" id="sswModeSingleBtn" onclick="sswSetMode('single')" class="ship-toggle-btn ship-toggle-active">Single Unit</button>
                        <button type="button" id="sswModeBulkBtn" onclick="sswSetMode('bulk')" class="ship-toggle-btn">Multiple (Bulk)</button>
                    </div>

                    <div id="sswSingleFields">
                        <div style="position:relative; margin-bottom:8px;">
                            <label class="ship-lbl">Hardware (Serial) *</label>
                            <input type="text" id="ssw_eSearch" class="slds-input ship-in" placeholder="Search serial..." autocomplete="off" oninput="sswEquipSearch(this.value)">
                            <input type="hidden" id="ssw_equipId">
                            <div id="ssw_eSuggest" class="suggestions-list"></div>
                        </div>
                        <div style="margin-bottom:8px;"><label class="ship-lbl">TID</label><input type="text" id="ssw_tid" class="slds-input ship-in" placeholder="TID"></div>
                    </div>

                    <div id="sswBulkFields" style="display:none; margin-bottom:8px;">
                        <div style="position:relative; margin-bottom:6px;">
                            <label class="ship-lbl">Add Units (Serial) *</label>
                            <input type="text" id="ssw_bulkSearch" class="slds-input ship-in" placeholder="Search serial..." autocomplete="off" oninput="sswBulkEquipSearch(this.value)">
                            <div id="ssw_bulkSuggest" class="suggestions-list"></div>
                        </div>
                        <div id="ssw_bulkList" style="min-height:40px; border:1px solid #e2e8f0; border-radius:8px; padding:6px; background:#f8fafc; font-size:12px;"></div>
                    </div>

                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px;">
                        <div><label class="ship-lbl">Deployment Date</label><input type="date" id="ssw_depDate" class="slds-input ship-in"></div>
                        <div><label class="ship-lbl">Purchase Type *</label>
                            <select id="ssw_purchaseType" class="slds-select ship-in" style="width:100%;border-radius:8px;">
                                <option value="Free Placement">Free Placement</option>
                                <option value="Agent Purchase">Agent Purchase</option>
                                <option value="Rental">Rental</option>
                                <option value="Reprogram">Reprogram</option>
                                <option value="Swap">Swap</option>
                                <option value="Swap/No Return">Swap/No Return</option>
                            </select>
                        </div>
                    </div>

                    <div style="font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px;margin:12px 0 8px;border-top:1px solid #eef2f7;padding-top:10px;">Order Summary (ShipStation)</div>
                    <div style="margin-bottom:8px;"><label class="ship-lbl">Store *</label>
                        <select id="ssw_store" class="slds-select ship-in" style="width:100%;border-radius:8px;"><option value="">— Select store —</option></select>
                    </div>
                    <div style="margin-bottom:4px;"><label class="ship-lbl">Order # *</label>
                        <input type="text" id="ssw_orderNum" class="slds-input ship-in" placeholder="Order # will be autogenerated" disabled>
                    </div>
                    <label style="display:flex; align-items:center; gap:6px; font-size:11px; color:#475569; margin-bottom:8px; cursor:pointer;">
                        <input type="checkbox" id="ssw_autoOrder" checked onchange="sswToggleAutoOrder()"> Autogenerate Order #
                    </label>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
                        <div><label class="ship-lbl">Order Date</label><input type="date" id="ssw_orderDate" class="slds-input ship-in"></div>
                        <div><label class="ship-lbl">Paid Date</label><input type="date" id="ssw_paidDate" class="slds-input ship-in"></div>
                        <div><label class="ship-lbl">Shipping Paid</label><input type="number" step="0.01" id="ssw_shipPaid" class="slds-input ship-in" placeholder="$"></div>
                        <div><label class="ship-lbl">Tax Paid</label><input type="number" step="0.01" id="ssw_taxPaid" class="slds-input ship-in" placeholder="$"></div>
                        <div style="grid-column:1/-1;"><label class="ship-lbl">Total Paid</label><input type="number" step="0.01" id="ssw_totalPaid" class="slds-input ship-in" placeholder="$"></div>
                    </div>
                </div>
            </div>

            <!-- Consolidated: additional branch merchants in the SAME box -->
            <div style="margin-top:16px; border-top:1px dashed #cbd5e1; padding-top:12px;">
                <div style="font-size:10px;font-weight:800;color:#0369a1;text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;">📦 Same Box — Additional Branches (optional)</div>
                <div style="font-size:11px;color:#64748b;margin-bottom:8px;">Other branch MIDs shipping in this <b>same box</b>. Creates a ticket for each, but <b>one ShipStation label / one charge / one tracking #</b> — all tickets sync together.</div>
                <div style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 10px;margin-bottom:8px;">⚠️ <b>Use this only when everything ships to ONE address</b> — the single destination set above:
                    <ul style="margin:5px 0 0 16px;padding:0;">
                        <li><b>Send to Merchant:</b> all branches' equipment goes to <b>this merchant's address</b>.</li>
                        <li><b>Send to Partner:</b> all branches' equipment goes to <b>the partner's address</b>.</li>
                    </ul>
                    If a branch needs delivery to a <b>different address</b>, don't add it here — create a separate ticket for it instead.</div>
                <div id="sswBranchList"></div>
                <button type="button" onclick="sswAddBranch()" style="padding:6px 14px;background:#eef2ff;color:#0369a1;border:1px solid #bfdbfe;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;">+ Add branch</button>
            </div>

            <div style="margin-top:16px;"><label class="ship-lbl">Internal Notes</label><textarea id="ssw_notes" class="slds-textarea" placeholder="Internal notes..." style="height:50px;"></textarea></div>
            <button type="submit" id="sswSubmitBtn" class="slds-button slds-button_brand slds-size_1-of-1" style="background:var(--pp-blue,#004990); margin-top:12px;">CREATE SHIPSTATION DEPLOYMENT</button>
            </form>
        </div>
    </div>
</div>`;

    // ─────────────────────────── inject CSS + HTML once ───────────────────────────
    function ensureInjected() {
        if (!document.getElementById('ssDeployWizardStyle')) {
            var style = document.createElement('style');
            style.id = 'ssDeployWizardStyle';
            style.textContent = WIZ_CSS;
            document.head.appendChild(style);
        }
        if (!document.getElementById('ssWizardModal')) {
            var wrap = document.createElement('div');
            wrap.innerHTML = WIZ_HTML.trim();
            var modal = wrap.firstElementChild;
            document.body.appendChild(modal);
        }
    }

    // ════════════ SHIPSTATION-READY WIZARD (extracted) ════════════

    // Entry point for the "+ New Ticket" button — behavior driven by the mode
    function newTicketEntry() {
        if (_ssReadyMode === 'disabled') { if (_wizOpts.onStandard) _wizOpts.onStandard(); return; }
        sswResetAll();
        document.getElementById('ssWizardModal').style.display = 'flex';
        if (_ssReadyMode === 'ss_only') {
            sswGoScreen(2);              // skip the choice screen — only ShipStation Ready
        } else {
            sswApplyMode();             // coming_soon (or any non-disabled with both cards)
            sswGoScreen(1);
        }
    }

    // Configure Screen 1 cards for the current mode
    function sswApplyMode() {
        const std = document.getElementById('sswCardStandard');
        const ss = document.getElementById('sswCardSS');
        const sub = document.getElementById('sswCardSSsub');
        const badge = document.getElementById('sswComingSoonBadge');
        // reset to defaults
        if (std) std.style.display = '';
        if (ss) { ss.style.opacity = ''; ss.style.pointerEvents = ''; ss.onclick = () => sswGoScreen(2); }
        if (badge) badge.style.display = 'none';
        if (sub) sub.textContent = 'Integrated with ShipStation order details';

        if (_ssReadyMode === 'coming_soon') {
            if (ss) { ss.style.opacity = '0.55'; ss.style.pointerEvents = 'none'; ss.onclick = null; }
            if (badge) badge.style.display = 'inline-block';
            if (sub) sub.textContent = 'Coming soon — not yet available';
        } else if (_ssReadyMode === 'ss_only') {
            if (std) std.style.display = 'none';   // hide the plain Create Ticket card
        }
    }

    function sswGoScreen(n) {
        ['sswScreen1', 'sswScreen2', 'sswScreen3'].forEach((id, i) => {
            document.getElementById(id).style.display = (i === n - 1) ? 'block' : 'none';
        });
    }

    function sswOpenLegacyModal() {
        document.getElementById('ssWizardModal').style.display = 'none';
        if (_wizOpts.onStandard) _wizOpts.onStandard();
    }

    function sswResetAll() {
        _ssMode = 'merchant'; _ssDepMode = 'single'; _ssBulkItems = [];
        _ssMerchant = null; _ssPartner = null;
        sswResetForm();
    }

    function sswResetForm() {
        ['ssw_partnerSearch', 'ssw_partnerId', 'ssw_merchantSearch', 'ssw_merchantId', 'ssw_name', 'ssw_company',
            'ssw_addr1', 'ssw_addr2', 'ssw_city', 'ssw_state', 'ssw_zip', 'ssw_phone', 'ssw_email',
            'ssw_eSearch', 'ssw_equipId', 'ssw_tid', 'ssw_bulkSearch', 'ssw_orderNum', 'ssw_shipPaid', 'ssw_taxPaid', 'ssw_totalPaid', 'ssw_notes']
            .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const c = document.getElementById('ssw_country'); if (c) c.value = 'United States';
        const pt = document.getElementById('ssw_purchaseType'); if (pt) pt.value = 'Free Placement';
        const tie = document.getElementById('ssw_merchantTie'); if (tie) tie.style.display = 'none';
        const bl = document.getElementById('ssw_bulkList'); if (bl) bl.innerHTML = '';
        _ssBranches = []; window._ssBranches = _ssBranches; sswRenderBranches();
        const auto = document.getElementById('ssw_autoOrder'); if (auto) auto.checked = true;
        const notify = document.getElementById('ssw_notify'); if (notify) notify.checked = false;
        const sb = document.getElementById('ssw_saveBack'); if (sb) sb.checked = true;
        sswToggleAutoOrder();
        sswSetMode('single');
    }

    async function sswStart(mode) {
        _ssMode = mode;
        _ssMerchant = null; _ssPartner = null;
        sswResetForm();
        const isPartner = mode === 'partner';
        document.getElementById('sswPartnerLookupWrap').style.display = isPartner ? 'block' : 'none';
        document.getElementById('ssw_notifyWrap').style.display = isPartner ? 'flex' : 'none';
        document.getElementById('sswFormTitle').innerText = isPartner ? 'Ship to Partner — ShipStation Order' : 'Ship to Merchant — ShipStation Order';
        document.getElementById('sswMerchantLbl').innerText = isPartner ? 'Merchant (tied to partner) *' : 'Merchant *';
        document.getElementById('ssw_saveBackTarget').innerText = isPartner ? 'partner' : 'merchant';
        const today = fmtDateInput(new Date());
        document.getElementById('ssw_depDate').value = today;
        document.getElementById('ssw_orderDate').value = today;
        document.getElementById('ssw_paidDate').value = today;
        await sswLoadStoresInto('ssw_store');
        sswGoScreen(3);
        await _applyPrefillMerchant();
    }

    function sswSetMode(m) {
        _ssDepMode = m;
        document.getElementById('sswModeSingleBtn').classList.toggle('ship-toggle-active', m === 'single');
        document.getElementById('sswModeBulkBtn').classList.toggle('ship-toggle-active', m === 'bulk');
        document.getElementById('sswSingleFields').style.display = m === 'single' ? 'block' : 'none';
        document.getElementById('sswBulkFields').style.display = m === 'bulk' ? 'block' : 'none';
    }

    function sswToggleAutoOrder() {
        const auto = document.getElementById('ssw_autoOrder').checked;
        const inp = document.getElementById('ssw_orderNum');
        inp.disabled = auto;
        inp.placeholder = auto ? 'Order # will be autogenerated' : 'Enter custom order #';
        if (auto) inp.value = '';
    }

    // Loads live ShipStation stores (sales channels) into a <select> id.
    async function sswLoadStoresInto(selId) {
        const sel = document.getElementById(selId);
        sel.innerHTML = '<option value="">Loading stores…</option>';
        try {
            const res = await fetch('/api/shipstation', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ action: 'get_stores' })
            });
            const result = await res.json();
            if (result.configured === false) {
                sel.innerHTML = '<option value="">— Add ShipStation API keys (Vercel) to load stores —</option>';
                return;
            }
            if (!result.success) {
                sel.innerHTML = '<option value="">— Failed to load stores —</option>';
                return;
            }
            sel.innerHTML = '<option value="">— Select store —</option>' +
                (result.stores || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('');
        } catch (e) {
            console.error('[ssStores]', e);
            sel.innerHTML = '<option value="">— Failed to load stores —</option>';
        }
    }

    // ── Partner lookup (search by partner name / company / agent name / agent id) ──
    function sswPartnerSearch(val) {
        const list = document.getElementById('ssw_partnerSuggest');
        if (val.length < 2) { list.style.display = 'none'; return; }
        clearTimeout(_ssLookupTimer);
        _ssLookupTimer = setTimeout(async () => {
            const res = await fetch('/api/deployments', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ action: 'getPartnerLookups', query: val })
            });
            const result = await res.json();
            window._sswPartners = result.partners || [];
            list.innerHTML = window._sswPartners.map((p, idx) => {
                const agentsStr = (p.agents || []).map(a => `${a.agent_id} (${a.merchant_count})`).join(', ');
                return `<div class="suggestion-item" onclick="sswSelectPartner(${idx})">
                    <strong style="color:#004990;">${p.full_name || '—'}</strong>${p.company_name ? ` · <span style="color:#64748b;font-weight:400;">${p.company_name}</span>` : ''}
                    <div style="font-size:10px;color:#64748b;">${p.email || ''}</div>
                    <div style="font-size:10px;color:#0369a1;font-weight:700;">Agent IDs (merchants): ${agentsStr || '—'}</div>
                </div>`;
            }).join('') || '<div style="padding:8px;color:#94a3b8;font-size:12px;">No partners found</div>';
            list.style.display = 'block';
        }, 300);
    }

    function sswSelectPartner(idx) {
        const p = (window._sswPartners || [])[idx];
        if (!p) return;
        _ssPartner = p;
        document.getElementById('ssw_partnerId').value = p.id;
        document.getElementById('ssw_partnerSearch').value = p.full_name || (p.company_name || '');
        document.getElementById('ssw_partnerSuggest').style.display = 'none';
        // recipient = partner
        const set = (id, v) => { document.getElementById(id).value = v || ''; };
        set('ssw_name', p.full_name); set('ssw_company', '');
        set('ssw_addr1', p.address); set('ssw_city', p.city); set('ssw_state', p.state);
        set('ssw_zip', p.zip); set('ssw_phone', p.phone_number); set('ssw_email', p.email);
        document.getElementById('ssw_country').value = p.country || 'United States';
        // reset merchant selection (must pick one tied to this partner)
        _ssMerchant = null;
        document.getElementById('ssw_merchantId').value = '';
        document.getElementById('ssw_merchantSearch').value = '';
        const tie = document.getElementById('ssw_merchantTie'); if (tie) tie.style.display = 'none';
        // If the partner has no address on file, pull it from HighLevel
        if (!p.address || !p.city || !p.zip) ssPullPartnerGhl(p.id, 'ssw_addr1', 'ssw_city', 'ssw_state', 'ssw_zip', 'ssw_country');
    }

    // Fill empty address fields from the partner's GHL (HighLevel) contact.
    async function ssPullPartnerGhl(partnerId, addrId, cityId, stateId, zipId, countryId) {
        try {
            const res = await fetch('/api/deployments', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ action: 'pull_partner_ghl', partner_id: partnerId })
            });
            const r = await res.json();
            if (!r.success || !r.ghl) return;
            const g = r.ghl;
            const fillIfEmpty = (id, v) => { const el = document.getElementById(id); if (el && !el.value && v) el.value = v; };
            fillIfEmpty(addrId, g.address);
            fillIfEmpty(cityId, g.city);
            fillIfEmpty(stateId, g.state);
            fillIfEmpty(zipId, g.zip);
            const c = document.getElementById(countryId);
            if (c && (!c.value || c.value === 'United States') && g.country) c.value = g.country;
        } catch (e) { console.error('[pull_partner_ghl]', e); }
    }

    // ── Merchant lookup (mode-aware) ──
    function sswMerchantSearch(val) {
        const list = document.getElementById('ssw_merchantSuggest');
        if (_ssMode === 'partner' && !_ssPartner) {
            list.innerHTML = '<div style="padding:8px;color:#b45309;font-size:12px;">Select a partner first</div>';
            list.style.display = 'block'; return;
        }
        if (val.length < 1 && _ssMode === 'merchant') { list.style.display = 'none'; return; }
        clearTimeout(_ssLookupTimer);
        _ssLookupTimer = setTimeout(async () => {
            let result;
            if (_ssMode === 'partner') {
                const res = await fetch('/api/deployments', {
                    method: 'POST', headers: authHeaders(),
                    body: JSON.stringify({ action: 'getPartnerMerchants', partner_id: _ssPartner.id, query: val })
                });
                result = await res.json();
            } else {
                const res = await fetch('/api/deployments', {
                    method: 'POST', headers: authHeaders(),
                    body: JSON.stringify({ action: 'getLookups', query: val })
                });
                result = await res.json();
            }
            const merchants = result.merchants || [];
            window._sswMerchants = merchants;
            list.innerHTML = merchants.map((m, idx) =>
                `<div class="suggestion-item" onclick="sswSelectMerchant(${idx})">
                    <strong style="color:#004990;">${m.dba_name || '—'}</strong>
                    <div style="font-size:10px;color:#64748b;">MID: ${m.merchant_id || 'N/A'}${m.agent_id ? ` · Agent ID: <b style="color:#0369a1;">${m.agent_id}</b>` : ''}</div>
                </div>`).join('') || '<div style="padding:8px;color:#94a3b8;font-size:12px;">No merchants found</div>';
            list.style.display = 'block';
        }, 300);
    }

    async function sswSelectMerchant(idx) {
        const m0 = (window._sswMerchants || [])[idx];
        if (!m0) return;
        const id = m0.id;
        document.getElementById('ssw_merchantId').value = id;
        document.getElementById('ssw_merchantSearch').value = m0.dba_name || '';
        document.getElementById('ssw_merchantSuggest').style.display = 'none';
        // Show which partner/agent ID this merchant is tied to
        const tie = document.getElementById('ssw_merchantTie');
        if (m0.agent_id) {
            tie.style.display = 'block';
            tie.innerHTML = `🔗 This merchant is tied to <b>Agent ID ${m0.agent_id}</b>${_ssPartner ? ` (partner: ${_ssPartner.full_name || _ssPartner.company_name || ''})` : ''}`;
        } else {
            tie.style.display = 'none';
        }
        // In merchant mode the recipient = merchant → autofill from getShipInfo
        if (_ssMode === 'merchant') {
            try {
                const res = await fetch('/api/deployments', {
                    method: 'POST', headers: authHeaders(),
                    body: JSON.stringify({ action: 'getShipInfo', merchant_id: id })
                });
                const result = await res.json();
                const m = result.merchant || {};
                _ssMerchant = m;
                _ssMerchantPartner = result.partner || null;
                const set = (eid, v) => { document.getElementById(eid).value = v || ''; };
                set('ssw_name', m.merchant_primary_contact || m.dba_name);
                set('ssw_company', m.dba_name);
                set('ssw_addr1', m.merchant_address); set('ssw_city', m.merchant_city);
                set('ssw_state', m.merchant_state); set('ssw_zip', m.merchant_zip);
                set('ssw_phone', m.merchant_phone); set('ssw_email', m.email);
                document.getElementById('ssw_country').value = m.merchant_country || 'United States';
                // Reset + reveal the "use partner email" option for this merchant
                const cbWrap = document.getElementById('ssw_usePartnerEmailWrap');
                const cb = document.getElementById('ssw_usePartnerEmail');
                const hint = document.getElementById('ssw_usePartnerEmailHint');
                if (cb) cb.checked = false;
                if (cbWrap) cbWrap.style.display = 'flex';
                if (hint) hint.textContent = _ssMerchantPartner
                    ? '(' + (_ssMerchantPartner.full_name || 'partner') + (_ssMerchantPartner.email ? ' · ' + _ssMerchantPartner.email : ' · no email on file') + ')'
                    : '(no partner found for this merchant)';
            } catch (e) { console.error('[ssMerchant]', e); }
        } else {
            _ssMerchant = { id }; // partner mode: merchant just ties the record
        }
    }

    // Toggle the recipient email between the merchant's and the auto-resolved partner's.
    function sswTogglePartnerEmail() {
        const cb = document.getElementById('ssw_usePartnerEmail');
        const emailField = document.getElementById('ssw_email');
        if (!cb || !emailField) return;
        if (cb.checked) {
            emailField.value = (_ssMerchantPartner && _ssMerchantPartner.email) ? _ssMerchantPartner.email : '';
            emailField.placeholder = _ssMerchantPartner && _ssMerchantPartner.email ? 'Email' : 'Partner has no email on file';
        } else {
            emailField.value = (_ssMerchant && _ssMerchant.email) ? _ssMerchant.email : '';
            emailField.placeholder = 'Email';
        }
    }

    // ── Equipment lookup (single + bulk) ──
    function sswEquipSearch(val) {
        const list = document.getElementById('ssw_eSuggest');
        if (val.length < 1) { list.style.display = 'none'; return; }
        clearTimeout(_ssLookupTimer);
        _ssLookupTimer = setTimeout(async () => {
            const res = await fetch('/api/deployments', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ action: 'getLookups', query: val })
            });
            const result = await res.json();
            list.innerHTML = (result.inventory || []).map(e =>
                `<div class="suggestion-item" onclick="sswSelectEquip('${e.id}','${e.serial_number}')">
                    <strong>${e.serial_number}</strong>
                    <div style="font-size:10px;color:#64748b;">${e.terminal_type || ''}</div>
                </div>`).join('') || '<div style="padding:8px;color:#94a3b8;font-size:12px;">No stocked units</div>';
            list.style.display = 'block';
        }, 300);
    }

    function sswSelectEquip(id, serial) {
        document.getElementById('ssw_equipId').value = id;
        document.getElementById('ssw_eSearch').value = serial;
        document.getElementById('ssw_eSuggest').style.display = 'none';
    }

    // ── Consolidated branches (same box) ──
    function sswRenderBranches() {
        const wrap = document.getElementById('sswBranchList');
        if (!wrap) return;
        const esc = s => String(s == null ? '' : s).replace(/"/g, '&quot;');
        wrap.innerHTML = _ssBranches.map((b, i) => `
            <div style="border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:8px;background:#fafbff;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <span style="font-size:11px;font-weight:800;color:#0369a1;">BRANCH ${i + 1}${b.merchant_id ? ' ✓' : ''}</span>
                    <button type="button" onclick="sswRemoveBranch(${i})" style="padding:2px 9px;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:6px;font-size:12px;cursor:pointer;">✕</button>
                </div>
                <div style="position:relative;margin-bottom:6px;">
                    <label class="ship-lbl">Branch Merchant *</label>
                    <input type="text" value="${esc(b.merchant_name)}" placeholder="Search branch merchant..." autocomplete="off"
                        oninput="sswBranchMerchantSearch(${i}, this.value)" onblur="trkHide('sswBrMSug${i}')" class="slds-input ship-in">
                    <div id="sswBrMSug${i}" class="suggestions-list" style="display:none;"></div>
                </div>
                <div style="position:relative;margin-bottom:6px;">
                    <label class="ship-lbl">Hardware (Serials) * <span style="font-weight:500;color:#94a3b8;">— add one or more units</span></label>
                    <input type="text" id="sswBrEInput${i}" placeholder="Search serial, then pick to add..." autocomplete="off"
                        oninput="sswBranchEquipSearch(${i}, this.value)" onblur="trkHide('sswBrESug${i}')" class="slds-input ship-in">
                    <div id="sswBrESug${i}" class="suggestions-list" style="display:none;"></div>
                    ${(b.units || []).length ? `<div style="margin-top:6px;display:flex;flex-direction:column;gap:5px;">
                        ${b.units.map((u, j) => `<div style="display:flex;align-items:center;gap:6px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:5px 8px;">
                            <span style="font-family:monospace;font-weight:700;color:#004990;font-size:12px;flex:0 0 auto;">${esc(u.serial)}</span>
                            <input type="text" value="${esc(u.tid)}" placeholder="TID (optional)" oninput="_ssBranches[${i}].units[${j}].tid=this.value" class="slds-input" style="flex:1;height:28px;font-size:12px;">
                            <button type="button" onclick="sswBranchRemoveUnit(${i},${j})" style="flex:0 0 auto;padding:2px 8px;background:#fff;color:#dc2626;border:1px solid #fecaca;border-radius:5px;font-size:12px;cursor:pointer;">✕</button>
                        </div>`).join('')}
                    </div>` : '<div style="margin-top:5px;font-size:11px;color:#b45309;">No units added yet.</div>'}
                </div>
                <div>
                    <label class="ship-lbl">Purchase Type *</label>
                    <select onchange="_ssBranches[${i}].purchase_type=this.value" class="slds-select ship-in" style="border-radius:8px;width:100%;">
                        ${['Free Placement', 'Agent Purchase', 'Rental', 'Reprogram', 'Swap', 'Swap/No Return'].map(pt => `<option value="${pt}" ${b.purchase_type === pt ? 'selected' : ''}>${pt}</option>`).join('')}
                    </select>
                </div>
            </div>`).join('');
    }
    function sswAddBranch() {
        if (_ssMode === 'partner' && !_ssPartner) return Swal.fire('Select a partner first', 'Pick the partner before adding branches.', 'warning');
        const defPt = (document.getElementById('ssw_purchaseType')?.value) || 'Free Placement';
        _ssBranches.push({ merchant_id: '', merchant_name: '', units: [], purchase_type: defPt });
        sswRenderBranches();
    }
    function sswRemoveBranch(i) { _ssBranches.splice(i, 1); sswRenderBranches(); }
    function sswBranchMerchantSearch(i, val) {
        const list = document.getElementById('sswBrMSug' + i);
        if (!list) return;
        clearTimeout(_ssLookupTimer);
        _ssLookupTimer = setTimeout(async () => {
            let result;
            if (_ssMode === 'partner') {
                const res = await fetch('/api/deployments', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'getPartnerMerchants', partner_id: _ssPartner.id, query: val }) });
                result = await res.json();
            } else {
                const res = await fetch('/api/deployments', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'getLookups', query: val }) });
                result = await res.json();
            }
            const merchants = result.merchants || [];
            window['_sswBr' + i] = merchants;
            list.innerHTML = merchants.map((m, idx) =>
                `<div class="suggestion-item" onmousedown="sswSelectBranchMerchant(${i}, ${idx})">
                    <strong style="color:#004990;">${m.dba_name || '—'}</strong>
                    <div style="font-size:10px;color:#64748b;">MID: ${m.merchant_id || 'N/A'}</div>
                </div>`).join('') || '<div style="padding:8px;color:#94a3b8;font-size:12px;">No merchants found</div>';
            list.style.display = 'block';
        }, 300);
    }
    function sswSelectBranchMerchant(i, idx) {
        const m = (window['_sswBr' + i] || [])[idx]; if (!m) return;
        _ssBranches[i].merchant_id = m.id;
        _ssBranches[i].merchant_name = m.dba_name || '';
        sswRenderBranches();
    }
    function sswBranchEquipSearch(i, val) {
        const list = document.getElementById('sswBrESug' + i);
        if (!list) return;
        clearTimeout(_ssLookupTimer);
        _ssLookupTimer = setTimeout(async () => {
            const res = await fetch('/api/deployments', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'getLookups', query: val }) });
            const result = await res.json();
            list.innerHTML = (result.inventory || []).map(e =>
                `<div class="suggestion-item" onmousedown="sswSelectBranchEquip(${i}, '${e.id}', '${(e.serial_number || '').replace(/'/g, "\\'")}')">
                    <strong>${e.serial_number}</strong>
                    <div style="font-size:10px;color:#64748b;">${e.terminal_type || ''}</div>
                </div>`).join('') || '<div style="padding:8px;color:#94a3b8;font-size:12px;">No stocked units</div>';
            list.style.display = 'block';
        }, 300);
    }
    function sswSelectBranchEquip(i, id, serial) {
        if (!_ssBranches[i].units) _ssBranches[i].units = [];
        // avoid adding the same unit twice (within this branch or another)
        const already = _ssBranches.some(b => (b.units || []).some(u => u.equipment_id === id));
        if (already) { Swal.fire('Already added', 'That serial is already in this shipment.', 'info'); return; }
        _ssBranches[i].units.push({ equipment_id: id, serial: serial, tid: '' });
        sswRenderBranches();
    }
    function sswBranchRemoveUnit(i, j) { _ssBranches[i].units.splice(j, 1); sswRenderBranches(); }

    function sswBulkEquipSearch(val) {
        const list = document.getElementById('ssw_bulkSuggest');
        if (val.length < 1) { list.style.display = 'none'; return; }
        clearTimeout(_ssLookupTimer);
        _ssLookupTimer = setTimeout(async () => {
            const res = await fetch('/api/deployments', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ action: 'getLookups', query: val })
            });
            const result = await res.json();
            list.innerHTML = (result.inventory || []).map(e =>
                `<div class="suggestion-item" onclick="sswAddBulk('${e.id}','${e.serial_number}','${(e.terminal_type || '').replace(/'/g, "\\'")}')">
                    <strong>${e.serial_number}</strong>
                    <div style="font-size:10px;color:#64748b;">${e.terminal_type || ''}</div>
                </div>`).join('') || '<div style="padding:8px;color:#94a3b8;font-size:12px;">No stocked units</div>';
            list.style.display = 'block';
        }, 300);
    }

    function sswAddBulk(id, serial, type) {
        if (_ssBulkItems.some(i => i.equipment_id === id)) return;
        _ssBulkItems.push({ equipment_id: id, serial_number: serial, terminal_type: type, tid: '' });
        document.getElementById('ssw_bulkSearch').value = '';
        document.getElementById('ssw_bulkSuggest').style.display = 'none';
        sswRenderBulk();
    }

    function sswRemoveBulk(id) {
        _ssBulkItems = _ssBulkItems.filter(i => i.equipment_id !== id);
        sswRenderBulk();
    }

    function sswRenderBulk() {
        const el = document.getElementById('ssw_bulkList');
        if (!_ssBulkItems.length) { el.innerHTML = '<span style="color:#94a3b8;">No units added</span>'; return; }
        el.innerHTML = _ssBulkItems.map(i =>
            `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;">
                <strong style="font-family:monospace;">${i.serial_number}</strong>
                <span style="color:#64748b;font-size:11px;">${i.terminal_type || ''}</span>
                <input type="text" placeholder="TID" value="${i.tid || ''}" oninput="sswSetBulkTid('${i.equipment_id}',this.value)" style="margin-left:auto;width:90px;font-size:11px;padding:2px 6px;border:1px solid #e2e8f0;border-radius:5px;">
                <span class="material-icons" onclick="sswRemoveBulk('${i.equipment_id}')" style="font-size:15px;color:#dc2626;cursor:pointer;">close</span>
            </div>`).join('');
    }

    function sswSetBulkTid(id, val) {
        const it = _ssBulkItems.find(i => i.equipment_id === id);
        if (it) it.tid = val;
    }

    // Shared recipient validator — ShipStation rejects orders/labels with a bad
    // address or email. Returns an array of problem strings ([] = all good).
    function ssValidateRecipient(r) {
        const problems = [];
        const need = (val, label) => { if (!val || !String(val).trim()) problems.push(`${label} is required`); };
        need(r.name, 'Name');
        need(r.address, 'Street address');
        need(r.city, 'City');
        need(r.state, 'State');
        need(r.zip, 'ZIP');
        need(r.phone, 'Phone');
        need(r.email, 'Email');
        const country = (r.country || 'US');
        const isUS = /^(us|usa|united states)$/i.test(String(country).trim()) || /^US$/i.test(country);
        if (r.zip && isUS && !/^\d{5}(-\d{4})?$/.test(String(r.zip).trim())) {
            problems.push(`ZIP "${r.zip}" is invalid (US ZIPs are 5 digits)`);
        }
        if (r.email && r.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim())) {
            problems.push(`Email "${r.email}" is invalid`);
        }
        return problems;
    }

    async function sswSubmit(event) {
        event.preventDefault();
        const merchantId = document.getElementById('ssw_merchantId').value;
        if (!merchantId) return Swal.fire('Error', 'Please select a merchant', 'warning');
        if (_ssMode === 'partner' && !document.getElementById('ssw_partnerId').value)
            return Swal.fire('Error', 'Please select a partner', 'warning');

        const v = id => (document.getElementById(id).value || '').trim();

        // Verify recipient address + email before creating the ShipStation order
        const recipientProblems = ssValidateRecipient({
            name: v('ssw_name'), email: v('ssw_email'), phone: v('ssw_phone'), address: v('ssw_addr1'),
            city: v('ssw_city'), state: v('ssw_state'), zip: v('ssw_zip'), country: v('ssw_country')
        });
        if (recipientProblems.length) {
            return Swal.fire({
                icon: 'warning', title: 'Fix the recipient before creating',
                html: '<div style="text-align:left;font-size:13px;">• ' + recipientProblems.join('<br>• ') + '</div>'
            });
        }
        const saveBack = document.getElementById('ssw_saveBack').checked;
        const storeSel = document.getElementById('ssw_store');

        // Required order/hardware fields (both ship-to modes, single + bulk)
        const orderProblems = [];
        if (_ssDepMode === 'bulk') {
            if (!_ssBulkItems.length) orderProblems.push('Add at least one hardware unit (Serial)');
        } else if (!v('ssw_equipId')) {
            orderProblems.push('Hardware (Serial) is required');
        }
        if (!v('ssw_purchaseType')) orderProblems.push('Purchase Type is required');
        if (!storeSel.value) orderProblems.push('Store is required');
        if (!document.getElementById('ssw_autoOrder').checked && !v('ssw_orderNum'))
            orderProblems.push('Order # is required (or check “Auto”)');
        if (orderProblems.length) {
            return Swal.fire({
                icon: 'warning', title: 'Fill in the required fields',
                html: '<div style="text-align:left;font-size:13px;">• ' + orderProblems.join('<br>• ') + '</div>'
            });
        }

        const shipstation = {
            ss_store_id: storeSel.value || null,
            store_name: storeSel.value ? storeSel.options[storeSel.selectedIndex].text : null,
            order_number: document.getElementById('ssw_autoOrder').checked ? '' : v('ssw_orderNum'),
            order_date: v('ssw_orderDate') || null,
            paid_date: v('ssw_paidDate') || null,
            notify_merchant: _ssMode === 'partner' && document.getElementById('ssw_notify').checked,
            ship_to_name: v('ssw_name'), ship_to_company: v('ssw_company'),
            ship_to_phone: v('ssw_phone'), ship_to_email: v('ssw_email'),
            address: v('ssw_addr1'), address_line2: v('ssw_addr2'),
            city: v('ssw_city'), state: v('ssw_state'), zip: v('ssw_zip'), country: v('ssw_country'),
            shipping_paid: v('ssw_shipPaid'), tax_paid: v('ssw_taxPaid'), total_paid: v('ssw_totalPaid')
        };

        const payload = {
            merchant_id: merchantId,
            target_date: v('ssw_depDate'),
            purchase_type: v('ssw_purchaseType'),
            notes: v('ssw_notes'),
            ship_to_type: _ssMode,
            ship_to_partner_id: _ssMode === 'partner' ? document.getElementById('ssw_partnerId').value : null,
            shipstation
        };

        if (_ssDepMode === 'bulk') {
            if (!_ssBulkItems.length) return Swal.fire('Error', 'Please add at least one unit', 'warning');
            payload.is_bulk = true;
            payload.items = _ssBulkItems.map(i => ({ equipment_id: i.equipment_id, tid: i.tid || null }));
        } else {
            const eq = document.getElementById('ssw_equipId').value;
            if (!eq) return Swal.fire('Error', 'Please select a hardware unit', 'warning');
            payload.equipment_id = eq;
            payload.tid = v('ssw_tid');
        }

        // Save-back to the recipient's record
        if (saveBack) {
            if (_ssMode === 'partner') {
                payload.partner_updates = {
                    full_name: v('ssw_name'), phone_number: v('ssw_phone'), email: v('ssw_email'),
                    address: v('ssw_addr1'), city: v('ssw_city'), state: v('ssw_state'), zip: v('ssw_zip'), country: v('ssw_country')
                };
            } else {
                payload.merchant_updates = {
                    dba_name: v('ssw_company') || v('ssw_name'), merchant_primary_contact: v('ssw_name'),
                    merchant_phone: v('ssw_phone'), email: v('ssw_email'),
                    merchant_address: v('ssw_addr1'), merchant_city: v('ssw_city'),
                    merchant_state: v('ssw_state'), merchant_zip: v('ssw_zip'), merchant_country: v('ssw_country')
                };
                // Using the partner's email for notifications → don't overwrite the merchant's record email.
                const usePartnerEmail = document.getElementById('ssw_usePartnerEmail');
                if (usePartnerEmail && usePartnerEmail.checked) delete payload.merchant_updates.email;
            }
        }

        // Consolidated (same box, multiple branches)?
        const branches = _ssBranches.filter(b => b.merchant_id || (b.units && b.units.length));
        const useConsolidated = branches.length > 0;
        if (useConsolidated) {
            const incomplete = branches.some(b => !b.merchant_id || !(b.units && b.units.length));
            if (incomplete) return Swal.fire('Finish the branches', 'Each branch needs a merchant and at least one unit (or remove it).', 'warning');
        }

        const btn = document.getElementById('sswSubmitBtn');
        btn.disabled = true; btn.textContent = 'Creating...';
        try {
            let result, newId;
            if (useConsolidated) {
                const primary = payload.is_bulk
                    ? { merchant_id: merchantId, is_bulk: true, items: payload.items }
                    : { merchant_id: merchantId, equipment_id: payload.equipment_id, tid: payload.tid };
                const cPayload = {
                    target_date: payload.target_date, purchase_type: payload.purchase_type, notes: payload.notes,
                    ship_to_type: payload.ship_to_type, ship_to_partner_id: payload.ship_to_partner_id,
                    shipstation: payload.shipstation,
                    merchant_updates: payload.merchant_updates, partner_updates: payload.partner_updates,
                    merchants: [primary, ...branches.map(b => {
                        if (b.units.length > 1) {
                            return { merchant_id: b.merchant_id, is_bulk: true, items: b.units.map(u => ({ equipment_id: u.equipment_id, tid: u.tid || null })), purchase_type: b.purchase_type || null };
                        }
                        return { merchant_id: b.merchant_id, equipment_id: b.units[0].equipment_id, tid: b.units[0].tid || null, purchase_type: b.purchase_type || null };
                    })]
                };
                const res = await fetch('/api/deployments', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'create_consolidated', payload: cPayload }) });
                result = await res.json();
                if (!result.success) throw new Error(result.message);
                Swal.fire({ icon: 'success', title: `Consolidated shipment created (${(result.data || []).length} tickets)`, text: 'One label covers all branches — print it from any of the tickets.', timer: 2200, showConfirmButton: false });
                newId = Array.isArray(result.data) ? result.data[0]?.id : null;
            } else {
                const res = await fetch('/api/deployments', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ action: 'create', payload }) });
                result = await res.json();
                if (!result.success) throw new Error(result.message);
                Swal.fire({ icon: 'success', title: 'ShipStation Deployment Created', timer: 1300, showConfirmButton: false });
                newId = Array.isArray(result.data) ? result.data[0]?.id : result.data?.id;
            }
            document.getElementById('ssWizardModal').style.display = 'none';
            // Host is responsible for refreshing its list; hand off the new id.
            if (newId && _wizOpts.onCreated) _wizOpts.onCreated(newId);
        } catch (e) {
            Swal.fire('Error', e.message, 'error');
        } finally {
            btn.disabled = false; btn.textContent = 'CREATE SHIPSTATION DEPLOYMENT';
        }
    }

    // ─────────────────────────── prefill helper ───────────────────────────
    // Pre-select a merchant (merchant ship-to mode) so the user doesn't have to
    // search — reuses the original sswSelectMerchant flow (fetches getShipInfo
    // and auto-fills the recipient address fields).
    async function sswPrefillMerchant(id, name) {
        window._sswMerchants = [{ id: id, dba_name: name || '' }];
        await sswSelectMerchant(0);
    }

    // ─────────────────────────── mode resolution ───────────────────────────
    async function resolveMode() {
        if (_wizOpts.mode) { _ssReadyMode = _wizOpts.mode; return; }
        if (_modeCached !== null) { _ssReadyMode = _modeCached; return; }
        try {
            const res = await fetch('/api/app-settings', {
                method: 'POST', headers: authHeaders(),
                body: JSON.stringify({ action: 'get' })
            });
            const d = await res.json();
            const s = (d && d.settings) || {};
            _modeCached = s.shipstation_ready_mode || 'disabled';
        } catch (e) {
            _modeCached = 'disabled';
        }
        _ssReadyMode = _modeCached;
    }

    // ─────────────────────────── public open() ───────────────────────────
    async function open(opts) {
        _wizOpts = opts || {};
        ensureInjected();
        await resolveMode();

        if (_ssReadyMode === 'disabled') {
            if (_wizOpts.onStandard) _wizOpts.onStandard();
            return;
        }

        sswResetAll();
        document.getElementById('ssWizardModal').style.display = 'flex';

        // Follow the normal mode flow so the Standard-vs-ShipStation and
        // Merchant-vs-Partner choices are preserved even when a merchant is
        // preselected. The prefill is applied when the merchant form is reached
        // (see sswStart → _applyPrefillMerchant).
        if (_ssReadyMode === 'ss_only') {
            sswGoScreen(2);              // skip the choice screen — only ShipStation Ready
        } else {
            sswApplyMode();             // coming_soon / both
            sswGoScreen(1);
        }
    }

    // Apply a preselected merchant once the merchant ship-to form is shown.
    async function _applyPrefillMerchant() {
        if (_ssMode === 'merchant' && _wizOpts.prefillMerchant && _wizOpts.prefillMerchant.id) {
            await sswPrefillMerchant(_wizOpts.prefillMerchant.id, _wizOpts.prefillMerchant.name);
        }
    }

    // ─────────────────────────── expose globals for inline handlers ───────────────────────────
    window.newTicketEntry = newTicketEntry;
    window.sswApplyMode = sswApplyMode;
    window.sswGoScreen = sswGoScreen;
    window.sswOpenLegacyModal = sswOpenLegacyModal;
    window.sswResetAll = sswResetAll;
    window.sswResetForm = sswResetForm;
    window.sswStart = sswStart;
    window.sswSetMode = sswSetMode;
    window.sswToggleAutoOrder = sswToggleAutoOrder;
    window.sswLoadStoresInto = sswLoadStoresInto;
    window.sswPartnerSearch = sswPartnerSearch;
    window.sswSelectPartner = sswSelectPartner;
    window.ssPullPartnerGhl = ssPullPartnerGhl;
    window.sswMerchantSearch = sswMerchantSearch;
    window.sswSelectMerchant = sswSelectMerchant;
    window.sswTogglePartnerEmail = sswTogglePartnerEmail;
    window.sswEquipSearch = sswEquipSearch;
    window.sswSelectEquip = sswSelectEquip;
    window.sswRenderBranches = sswRenderBranches;
    window.sswAddBranch = sswAddBranch;
    window.sswRemoveBranch = sswRemoveBranch;
    window.sswBranchMerchantSearch = sswBranchMerchantSearch;
    window.sswSelectBranchMerchant = sswSelectBranchMerchant;
    window.sswBranchEquipSearch = sswBranchEquipSearch;
    window.sswSelectBranchEquip = sswSelectBranchEquip;
    window.sswBranchRemoveUnit = sswBranchRemoveUnit;
    window.sswBulkEquipSearch = sswBulkEquipSearch;
    window.sswAddBulk = sswAddBulk;
    window.sswRemoveBulk = sswRemoveBulk;
    window.sswRenderBulk = sswRenderBulk;
    window.sswSetBulkTid = sswSetBulkTid;
    window.ssValidateRecipient = ssValidateRecipient;
    window.sswSubmit = sswSubmit;
    window.trkHide = window.trkHide || trkHide;

    window.SSDeployWizard = { open: open };
})();
