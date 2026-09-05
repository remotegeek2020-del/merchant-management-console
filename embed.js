/*
 * PayProTec Announcements — external embed (Webflow, GoHighLevel, any site).
 * Usage:
 *   <script src="https://portal.mypayprotec.com/embed.js"
 *           data-site-key="YOUR_SITE_KEY"
 *           data-email="{{contact.email}}"     (optional identity)
 *           data-account="{{location.name}}">  (optional label)
 *   </script>
 *
 * Renders active announcements as a centered MODAL. Read-only, self-contained,
 * no dependencies. Auth = site key. Anonymous viewers are tracked by a stored
 * visitor id (or the supplied email). Per-campaign behavior (dismissible /
 * persistent / until_action) + re-show frequency mirror the internal portal.
 */
(function () {
    if (window.__ppEmbedLoaded) return; window.__ppEmbedLoaded = true;

    // Find our own <script> tag (for data-* attrs + origin). currentScript is
    // null when a host (e.g. GHL) injects the code via eval, so fall back to a
    // scan for embed.js among all script tags.
    var self = document.currentScript;
    if (!self || !/embed\.js/.test(self.src || '')) {
        var ss = document.getElementsByTagName('script');
        for (var i = 0; i < ss.length; i++) { if (/embed\.js(\?|$)/.test(ss[i].src)) { self = ss[i]; break; } }
    }

    // Config can come from (a) a global set before loading (raw-JS snippet), or
    // (b) data-* attributes on the <script> tag.
    var cfg = window.PPX || window.PPX_CONFIG || {};
    function attr(n) { return self && self.getAttribute ? (self.getAttribute(n) || '') : ''; }
    function qp(n) { try { return new URLSearchParams(location.search).get(n) || ''; } catch (e) { return ''; } }
    var SITE_KEY = cfg.siteKey || cfg.site_key || attr('data-site-key') || '';
    var ACCOUNT = String(cfg.account || attr('data-account') || '').trim();

    // Best-effort visitor email: explicit config/attr, a ?email= param, or an
    // email-shaped value in the site's OWN (first-party) cookies. Browsers do
    // NOT allow reading other domains' cookies (e.g. Google), so this only finds
    // an email the site itself stored (form fill / CRM).
    function cookie(n) {
        try { var m = document.cookie.match(new RegExp('(?:^|; )' + n.replace(/([.$?*|{}()\[\]\\\/+^])/g, '\\$1') + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; } catch (e) { return ''; }
    }
    function cookieEmail() {
        try {
            var raw = decodeURIComponent(document.cookie || '');
            var m = raw.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
            return m ? m[0] : '';
        } catch (e) { return ''; }
    }
    function sha256Hex(str) {
        if (!(window.crypto && crypto.subtle && window.TextEncoder)) return Promise.resolve('');
        try {
            return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (h) {
                return Array.prototype.map.call(new Uint8Array(h), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
            }).catch(function () { return ''; });
        } catch (e) { return Promise.resolve(''); }
    }
    var EMAIL = String(cfg.email || attr('data-email') || qp('email') || qp('contact_email') || cookieEmail() || '').trim();
    if (!SITE_KEY) { try { console.warn('[PPX] announcements: no site key (set window.PPX={siteKey:"…"} or data-site-key).'); } catch (e) {} return; }

    // API base = the origin embed.js was served from (works cross-domain). Prefer
    // an explicit override, then the script src, then this page's origin.
    var scriptSrc = (self && self.src) || cfg.src || '';
    var base = cfg.origin || (scriptSrc ? scriptSrc.replace(/\/embed\.js(\?.*)?$/, '') : location.origin);
    var API = base + '/api/embed';

    var VID_KEY = 'ppx_vid', SNOOZE_KEY = 'ppx_snooze', PERM_KEY = 'ppx_perm';
    var DEFAULT_FREQ_MIN = 5;

    function store(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
    function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

    function visitorId() {
        if (EMAIL) return 'email:' + EMAIL.toLowerCase();
        var v = null; try { v = localStorage.getItem(VID_KEY); } catch (e) {}
        if (!v) {
            v = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
                : ('v' + Date.now() + Math.random().toString(36).slice(2));
            try { localStorage.setItem(VID_KEY, v); } catch (e) {}
        }
        return v;
    }
    var VIEWER = visitorId();

    // Detect the current GHL sub-account (location) id from the app URL, so the
    // portal can target "all or selected sub-accounts". Works from the app frame
    // or a nested frame; cross-origin top access is ignored safely.
    function ghlLocation() {
        var override = cfg.ghlLocation || '';
        if (override) return String(override);
        var urls = [];
        try { urls.push(location.href); } catch (e) {}
        try { if (window.top && window.top !== window) urls.push(window.top.location.href); } catch (e) {}
        for (var i = 0; i < urls.length; i++) {
            var m = /\/location\/([A-Za-z0-9]{10,})/.exec(urls[i]);
            if (m) return m[1];
        }
        return null;
    }
    var GHL_LOC = ghlLocation();

    function esc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    // Only allow safe link schemes (blocks javascript:/data: URLs).
    function safeUrl(u) { u = String(u == null ? '' : u).trim(); return /^(https?:|mailto:|tel:|\/|#)/i.test(u) ? u : '#'; }
    function num(n) { n = parseFloat(n); return isFinite(n) ? n : 0; }
    // Sanitize a value used inside a JS string in an inline handler.
    function jsArg(s) { return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, ''); }
    // Body may be sanitized rich-text HTML (server-side) or legacy plain text.
    function bodyHtml(b) { b = b == null ? '' : String(b); return /<[a-z][\s\S]*>/i.test(b) ? b : esc(b).replace(/\n/g, '<br>'); }
    // Traffic context (anonymous): referrer, landing page, UTM, device, language.
    function trafficCtx() {
        function cut(s, n) { return String(s == null ? '' : s).slice(0, n); }
        var ua = navigator.userAgent || '';
        return {
            ref: cut(document.referrer, 300),
            url: cut(location.href, 300),
            utm_source: cut(qp('utm_source'), 120),
            utm_medium: cut(qp('utm_medium'), 120),
            utm_campaign: cut(qp('utm_campaign'), 120),
            device: /Mobi|Android|iPhone|iPad|iPod/i.test(ua) ? 'mobile' : 'desktop',
            lang: cut(navigator.language || '', 12),
            account: cut(ACCOUNT, 120),
            // Retargeting identifiers (click-IDs from URL, pixel cookies)
            fbclid: cut(qp('fbclid'), 200), gclid: cut(qp('gclid'), 200), li_fat_id: cut(qp('li_fat_id'), 120),
            fbp: cut(cookie('_fbp'), 120), fbc: cut(cookie('_fbc'), 200), gcl_au: cut(cookie('_gcl_au'), 120)
        };
    }
    var CTX = trafficCtx();

    function api(body) {
        body.site_key = SITE_KEY; body.viewer_id = VIEWER; if (GHL_LOC) body.ghl_location = GHL_LOC;
        // Pass the known email so opt-in suppression follows the person across
        // devices (server records/checks marketing_optins by email).
        if (EMAIL) body.email = EMAIL.toLowerCase();
        return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).catch(function () { return { success: false }; });
    }
    function track(id, type, target, variant) {
        api({ action: 'track', campaign_id: id, event_type: type, target: target || null, variant: variant || null, meta: CTX });
        if (type === 'impression') pixelEvent('PPTAnnouncementView');
        else if (type === 'click') pixelEvent('PPTAnnouncementClick');
    }

    // ── Retargeting pixels (Meta / Google / LinkedIn), injected from portal config ──
    var _pixelsDone = false;
    function injectPixels(p) {
        if (_pixelsDone || !p) return; _pixelsDone = true;
        try {
            if (p.fb) {
                !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s) }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
                window.fbq('init', String(p.fb)); window.fbq('track', 'PageView');
            }
        } catch (e) {}
        try {
            if (p.google) {
                var g = document.createElement('script'); g.async = true; g.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(p.google); document.head.appendChild(g);
                window.dataLayer = window.dataLayer || []; window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
                window.gtag('js', new Date()); window.gtag('config', String(p.google));
            }
        } catch (e) {}
        try {
            if (p.linkedin) {
                window._linkedin_partner_id = String(p.linkedin);
                window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
                window._linkedin_data_partner_ids.push(String(p.linkedin));
                (function (l) { if (!l) { window.lintrk = function (a, b) { window.lintrk.q.push([a, b]) }; window.lintrk.q = []; } var s = document.getElementsByTagName('script')[0]; var b = document.createElement('script'); b.type = 'text/javascript'; b.async = true; b.src = 'https://snap.licdn.com/li.lms-analytics/insight.min.js'; s.parentNode.insertBefore(b, s); })(window.lintrk);
            }
        } catch (e) {}
    }
    function pixelEvent(name) {
        try { if (window.fbq) window.fbq('trackCustom', name); } catch (e) {}
        try { if (window.gtag) window.gtag('event', name); } catch (e) {}
        try { if (window.lintrk) window.lintrk('track'); } catch (e) {}
    }

    // ── snooze / permanent (localStorage) ────────────────────────────────────
    function snoozeMap() { return store(SNOOZE_KEY) || {}; }
    function snooze(id) { var m = snoozeMap(); m[id] = Date.now(); save(SNOOZE_KEY, m); }
    function isSnoozed(c) { var m = snoozeMap(); var mins = (+c.reshow_minutes > 0 ? +c.reshow_minutes : DEFAULT_FREQ_MIN); return m[c.id] && (Date.now() - m[c.id]) < mins * 60000; }
    function permList() { return store(PERM_KEY) || []; }
    function permAdd(id) { var a = permList(); if (a.indexOf(id) === -1) { a.push(id); save(PERM_KEY, a); } }
    function isPerm(id) { return permList().indexOf(id) !== -1; }

    var queue = [], current = null, backdrop = null;

    function injectCss() {
        if (document.getElementById('ppx-css')) return;
        var s = document.createElement('style'); s.id = 'ppx-css';
        s.textContent = [
            // Scoped box-sizing reset so the host site's CSS can't distort us.
            '.ppx-back,.ppx-back *{box-sizing:border-box;}',
            '.ppx-back{position:fixed;inset:0;background:rgba(4,10,22,.6);z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;animation:ppxFade .2s ease;-webkit-font-smoothing:antialiased;}',
            '@keyframes ppxFade{from{opacity:0}to{opacity:1}}',
            // Fluid width, viewport-capped height, scrolls internally if tall.
            '.ppx-modal{background:#fff;border-radius:16px;width:min(460px,100%);max-height:90vh;max-height:90dvh;overflow-y:auto;overflow-x:hidden;box-shadow:0 24px 70px rgba(0,0,0,.4);position:relative;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#0a1628;animation:ppxUp .25s ease;-webkit-overflow-scrolling:touch;}',
            '@keyframes ppxUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}',
            '@keyframes ppxpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}',
            '.ppx-img{position:relative;line-height:0;}',
            '.ppx-img img{width:100%;height:auto;display:block;}',
            '.ppx-hot{position:absolute;display:block;cursor:pointer;border-radius:6px;}',
            '.ppx-hot:hover{background:rgba(0,73,144,.12);box-shadow:0 0 0 2px rgba(0,73,144,.5) inset;}',
            '.ppx-body{padding:clamp(16px,4vw,24px);}',
            '.ppx-title{font-size:clamp(1.05rem,3.6vw,1.2rem);font-weight:800;color:#0a1628;margin:0 0 8px;line-height:1.3;}',
            '.ppx-text{font-size:clamp(13px,3.4vw,14.5px);color:#475569;line-height:1.6;overflow-wrap:anywhere;}',
            '.ppx-text p{margin:0 0 8px;}.ppx-text p:last-child{margin-bottom:0;}.ppx-text a{color:#004990;}.ppx-text ul,.ppx-text ol{margin:0 0 8px;padding-left:20px;}',
            '.ppx-cta{display:block;text-align:center;margin-top:18px;background:#004990;color:#fff;border:none;border-radius:10px;padding:13px 18px;font-size:clamp(13px,3.6vw,14.5px);font-weight:700;cursor:pointer;text-decoration:none;line-height:1.2;}',
            '.ppx-cta:hover{filter:brightness(1.07);}',
            '.ppx-x{position:absolute;top:12px;right:12px;z-index:3;background:rgba(0,0,0,.5);color:#fff;border:none;border-radius:50%;width:32px;height:32px;font-size:19px;line-height:30px;text-align:center;cursor:pointer;padding:0;}',
            '.ppx-x:hover{background:rgba(0,0,0,.72);}',
            '.ppx-forget{display:flex;align-items:center;gap:7px;margin-top:14px;font-size:12px;color:#94a3b8;cursor:pointer;}',
            '.ppx-forget input{margin:0;flex:none;}',
            '.ppx-nav{margin-top:12px;text-align:center;font-size:11px;color:#94a3b8;font-weight:700;}',
            // Sticky bar teaser
            '.ppx-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;background:#fff;box-shadow:0 -4px 22px rgba(0,0,0,.16);animation:ppxUp .3s ease;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
            '.ppx-bar-in{display:flex;align-items:center;gap:14px;max-width:1080px;margin:0 auto;padding:12px 18px;}',
            '.ppx-bar-t{flex:1;font-weight:700;font-size:14px;color:#0a1628;}',
            '.ppx-bar-x{background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:#94a3b8;padding:0 4px;}',
            // Slide-in corner teaser
            '.ppx-slide{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:320px;max-width:calc(100vw - 24px);background:#fff;border-radius:14px;box-shadow:0 16px 50px rgba(0,0,0,.28);padding:18px;animation:ppxUp .3s ease;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
            '.ppx-slide-x{position:absolute;top:8px;right:10px;background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8;}',
            // Phones: dock to the bottom as a sheet, nearly full width.
            '@media (max-width:520px){.ppx-back{padding:10px;align-items:flex-end;}.ppx-modal{max-height:88vh;max-height:88dvh;}.ppx-bar-in{flex-wrap:wrap;}.ppx-slide{left:12px;right:12px;width:auto;}}',
            // ── Event Hero — split-screen layout (WSAA Partner Night style) ──
            '.ppx-hero-modal{background:#0b1220;border-radius:10px;width:min(720px,94vw);}',
            '.ppx-hero-grid{display:grid;grid-template-columns:1.15fr 0.85fr;min-height:340px;}',
            '.ppx-hero-left{padding:clamp(20px,4vw,30px);color:#fff;display:flex;flex-direction:column;justify-content:center;min-width:0;}',
            '.ppx-hero-eyebrow{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:800;letter-spacing:.08em;color:#f97316;text-transform:uppercase;margin-bottom:10px;}',
            '.ppx-hero-eyebrow span{width:7px;height:7px;background:#f97316;flex:none;}',
            '.ppx-hero-h1,.ppx-hero-h2{font-weight:900;font-size:clamp(26px,4vw,40px);line-height:0.98;text-transform:uppercase;overflow-wrap:anywhere;}',
            '.ppx-hero-h1{color:#fff;}.ppx-hero-h2{color:#f97316;}',
            '.ppx-hero-body{font-size:14px;color:#cbd5e1;line-height:1.6;margin-top:14px;}',
            '.ppx-hero-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;}',
            '.ppx-hero-chip{display:flex;align-items:center;gap:6px;background:#111a2e;border-radius:8px;padding:7px 11px;font-size:12px;font-weight:700;color:#e2e8f0;white-space:nowrap;}',
            '.ppx-hero-ctarow{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:20px;}',
            '.ppx-hero-cta{display:inline-block;background:#f97316;color:#fff;border:none;border-radius:8px;padding:14px 22px;font-size:14px;font-weight:800;cursor:pointer;text-decoration:none;font-family:inherit;}',
            '.ppx-hero-cta:hover{filter:brightness(1.07);}',
            '.ppx-hero-helper{font-size:12px;color:#94a3b8;}',
            '.ppx-hero-right{position:relative;background:#1e293b;min-height:220px;}',
            '.ppx-hero-right img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}',
            '.ppx-hero-badge{position:absolute;right:18px;top:50%;transform:translateY(-50%);background:#f97316;color:#fff;padding:12px 16px;border-radius:5px;box-shadow:0 10px 26px rgba(0,0,0,.4);}',
            '.ppx-hero-badge-dow,.ppx-hero-badge-mon{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;}',
            '.ppx-hero-badge-day{font-size:34px;font-weight:900;line-height:1;margin:2px 0;}',
            '.ppx-hero-badge-sub{font-size:10px;font-weight:700;margin-top:6px;border-top:1px solid rgba(255,255,255,.4);padding-top:6px;}',
            // Once the RSVP steps swap into the hero's left panel, restyle them for the dark bg.
            '.ppx-hero-left .ppx-title{color:#fff;}.ppx-hero-left .ppx-text{color:#cbd5e1;}',
            '.ppx-hero-left .ppx-cta{background:#f97316;}.ppx-hero-left .ppx-forget{color:#94a3b8;}',
            '@media (max-width:640px){.ppx-hero-grid{grid-template-columns:1fr;}.ppx-hero-right{min-height:180px;order:-1;}}'
        ].join('');
        document.head.appendChild(s);
    }

    // ── Watch-time milestones (fired while the video popup stays open) ──
    var _watchTimers = [];
    function clearWatchTimers() { _watchTimers.forEach(clearTimeout); _watchTimers = []; }
    function startWatchTimers(c) {
        clearWatchTimers();
        var v = c.variant;
        _watchTimers.push(setTimeout(function () { track(c.id, 'watch', 'w10', v); }, 10000));      // 10s+
        _watchTimers.push(setTimeout(function () { track(c.id, 'watch', 'w60', v); }, 60000));      // 1 min+
        _watchTimers.push(setTimeout(function () { track(c.id, 'watch', 'wlong', v); }, 300000));   // 5 min+ (long)
    }
    function close() { clearWatchTimers(); if (backdrop) { backdrop.remove(); backdrop = null; } current = null; next(); }
    function onClose() { if (current) snooze(current.id); close(); }
    function onForget() { if (current) { permAdd(current.id); track(current.id, 'dismiss', null, current.variant); api({ action: 'dismiss', campaign_id: current.id }); } close(); }
    function onAction(id, target) { permAdd(id); track(id, 'click', target || 'cta', current && current.variant); api({ action: 'dismiss', campaign_id: id }); close(); }
    function onClick(id, target) { track(id, 'click', target, current && current.variant); }
    window.__ppxClose = onClose; window.__ppxForget = onForget; window.__ppxAction = onAction; window.__ppxClick = onClick;

    // ── CTA gate: opt-in HighLevel form before the (e.g. YouTube) link ────────
    // External sites only (this pixel). Required: the video link is revealed after
    // the form is submitted. GHL form submissions are counted as conversions via
    // the campaign's conv_form_id (auto-set when the gate is configured).
    var _gateId = null, _gateUrl = '', _gateDone = false;
    window.__ppxGate = function (id) {
        var c = current; if (!c || c.id !== id || !c.cta_gate || !c.cta_gate.form_id) return;
        track(id, 'click', 'cta_gate_open', c.variant);
        var modal = backdrop && backdrop.querySelector('.ppx-modal'); if (!modal) return;
        _gateId = id; _gateUrl = safeUrl(c.cta_url); _gateDone = false;
        modal.innerHTML = '<button class="ppx-x" onclick="__ppxClose()">×</button>'
            + '<div class="ppx-body" style="text-align:center;">'
            + '<div class="ppx-title" id="ppx-gate-title" style="margin-bottom:6px;">Register to watch</div>'
            + '<div class="ppx-text" id="ppx-gate-sub" style="margin-bottom:12px;">Fill this out and we’ll take you straight to the video.</div>'
            + '<iframe id="ppx-gate-form" src="https://api.leadconnectorhq.com/widget/form/' + esc(c.cta_gate.form_id) + '" style="width:100%;min-height:520px;border:none;" scrolling="yes"></iframe>'
            + '<div id="ppx-gate-cont" style="margin-top:12px;display:none;"><a class="ppx-cta" id="ppx-gate-link" href="' + _gateUrl + '" target="_blank" rel="noopener" onclick="__ppxGateGo(\'' + id + '\')">▶ Continue to the video</a></div>'
            + '</div>';
    };
    function gateSubmitted() {
        if (!_gateId || _gateDone) return;
        _gateDone = true;
        track(_gateId, 'click', 'cta_gate_submit', current && current.variant);
        // Registered → don't show this ad again for this browser (localStorage,
        // persists on a normal browser; incognito clears on close) + server-side.
        permAdd(_gateId);
        api({ action: 'dismiss', campaign_id: _gateId });
        var t = document.getElementById('ppx-gate-title'), s = document.getElementById('ppx-gate-sub'), cont = document.getElementById('ppx-gate-cont');
        if (t) t.textContent = 'You’re registered! 🎉';
        if (s) s.textContent = 'Click below to watch.';
        if (cont) { cont.style.display = 'block'; try { cont.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} }
    }
    window.__ppxGateGo = function (id) { track(id, 'click', 'cta_gate_continue', current && current.variant); api({ action: 'dismiss', campaign_id: id }); setTimeout(close, 80); };
    // Detect the HighLevel form submission (cross-origin postMessage from the iframe).
    window.addEventListener('message', function (ev) {
        if (!_gateId || _gateDone) return;
        var o = String(ev.origin || '');
        if (o.indexOf('leadconnectorhq.com') === -1 && o.indexOf('leadconnector') === -1) return;
        var str = ''; try { str = typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data || ''); } catch (e) { str = ''; }
        if (/submit|success|thank|complete/i.test(str) && !/resize|height|scroll|ready|load/i.test(str)) gateSubmitted();
    });

    // ── Interactive survey (poll / rating / contact capture) ──────────────────
    // Explicit bg/color so inputs stay legible even on dark themes (Night Event,
    // Event Hero) — form controls don't inherit an ancestor's text color the
    // way a <div> would, so without this the text can render invisible.
    var INP = 'width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:9px;font-size:14px;font-family:inherit;box-sizing:border-box;background:#fff;color:#0a1628;';
    function req(s, f) { return s.contact && s.contact.required && s.contact.required.indexOf(f) !== -1; }
    function surveyHtml(c) {
        var s = c.survey; if (!s || !s.enabled) return '';
        var h = '<div class="ppx-survey" style="margin-top:16px;border-top:1px solid #eef2f7;padding-top:14px;text-align:left;">';
        if (s.question && s.options && s.options.length) {
            h += '<div style="font-weight:700;font-size:14px;margin-bottom:8px;">' + esc(s.question) + '</div><div style="display:flex;flex-direction:column;gap:6px;">';
            s.options.forEach(function (o) { h += '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;border:1px solid #e2e8f0;border-radius:8px;padding:9px 11px;"><input type="radio" name="ppxpoll" value="' + esc(o) + '" style="flex:none;"> ' + esc(o) + '</label>'; });
            h += '</div>';
        }
        if (s.rating && s.rating.enabled) {
            var max = s.rating.scale === 10 ? 10 : 5, start = s.rating.scale === 10 ? 0 : 1;
            h += '<div style="margin-top:' + (s.question ? '12px' : '0') + ';">';
            if (s.rating.label) h += '<div style="font-weight:700;font-size:14px;margin-bottom:8px;">' + esc(s.rating.label) + '</div>';
            h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
            for (var r = start; r <= max; r++) h += '<button type="button" class="ppx-rate" data-v="' + r + '" onclick="__ppxRate(this)" style="min-width:34px;height:34px;border:1.5px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer;font-weight:700;">' + r + '</button>';
            h += '</div></div>';
        }
        var ghlFormOnly = false;
        if (s.contact && s.contact.enabled) {
            if (s.contact.mode === 'ghl_form' && s.contact.ghl_form_id) {
                // Embed the HighLevel form itself — it handles its own submit + tags.
                ghlFormOnly = !(s.question && s.options && s.options.length) && !(s.rating && s.rating.enabled);
                h += '<div style="margin-top:12px;"><iframe src="https://api.leadconnectorhq.com/widget/form/' + esc(s.contact.ghl_form_id) + '" style="width:100%;min-height:480px;border:none;" scrolling="yes"></iframe></div>';
            } else {
                h += '<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px;">';
                if (s.contact.name) h += '<input class="ppx-c-name" placeholder="Your name' + (req(s, 'name') ? ' *' : '') + '" style="' + INP + '">';
                if (s.contact.email) h += '<input class="ppx-c-email" type="email" placeholder="Email' + (req(s, 'email') ? ' *' : '') + '" style="' + INP + '">';
                if (s.contact.phone) h += '<input class="ppx-c-phone" placeholder="Phone' + (req(s, 'phone') ? ' *' : '') + '" style="' + INP + '">';
                h += '</div>';
            }
        }
        if (!ghlFormOnly) {
            h += '<button type="button" class="ppx-cta" style="margin-top:14px;" onclick="__ppxSurvey(this)">Submit</button>';
            h += '<div class="ppx-survey-msg" style="font-size:12px;color:#dc2626;margin-top:6px;min-height:14px;"></div>';
        }
        h += '</div>';
        return h;
    }
    window.__ppxRate = function (btn) {
        var wrap = btn.parentNode;
        Array.prototype.forEach.call(wrap.querySelectorAll('.ppx-rate'), function (b) { b.style.background = '#fff'; b.style.color = '#0a1628'; b.style.borderColor = '#cbd5e1'; });
        btn.style.background = '#004990'; btn.style.color = '#fff'; btn.style.borderColor = '#004990';
        wrap.setAttribute('data-picked', btn.getAttribute('data-v'));
    };
    window.__ppxSurvey = function (btn) {
        var box = btn.closest ? btn.closest('.ppx-survey') : null;
        if (!box || !current) return;
        var s = current.survey || {};
        var msg = box.querySelector('.ppx-survey-msg');
        var picked = box.querySelector('input[name=ppxpoll]:checked');
        var choice = picked ? picked.value : null;
        var rateWrap = box.querySelector('[data-picked]');
        var rating = rateWrap ? rateWrap.getAttribute('data-picked') : null;
        var g = function (cls) { var el = box.querySelector(cls); return el ? el.value.trim() : ''; };
        var name = g('.ppx-c-name'), email = g('.ppx-c-email'), phone = g('.ppx-c-phone');
        // Validate required contact fields.
        if (s.contact && s.contact.enabled) {
            var rq = s.contact.required || [];
            if (rq.indexOf('name') !== -1 && !name) { msg.textContent = 'Please enter your name.'; return; }
            if (rq.indexOf('email') !== -1 && !email) { msg.textContent = 'Please enter your email.'; return; }
            if (rq.indexOf('phone') !== -1 && !phone) { msg.textContent = 'Please enter your phone.'; return; }
            if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = 'Please enter a valid email.'; return; }
        }
        if (!choice && !rating && !name && !email && !phone) { msg.textContent = 'Please answer before submitting.'; return; }
        btn.disabled = true; btn.textContent = 'Submitting…';
        api({ action: 'submit_response', campaign_id: current.id, choice: choice, rating: rating, name: name, email: email, phone: phone, variant: current.variant, meta: CTX });
        track(current.id, 'click', 'survey', current.variant);
        permAdd(current.id);   // don't re-ask
        box.innerHTML = '<div style="text-align:center;padding:14px 6px;"><div style="font-size:34px;">✅</div><div style="font-weight:700;font-size:15px;margin-top:6px;">' + esc(s.thanks || 'Thanks for your response!') + '</div></div>';
        setTimeout(close, 1600);
    };

    // ── Partner-exclusive RSVP flow — runs entirely INSIDE this popup ──────────
    // (Partner ID → confirm/questions → submit), no navigation off the host
    // site. Talks straight to the public RSVP API (same one rsvp.html uses).
    var RSVP_API = base + '/api/rsvp';
    function rsvpApi(body) {
        return fetch(RSVP_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r.json(); }).catch(function () { return { success: false, message: 'Network error.' }; });
    }
    var _rsvpCfg = null, _rsvpPartner = null;
    function rsvpFieldInput(f) {
        var id = 'ppx-rf-' + jsArg(f.name);
        if (f.type === 'textarea') return '<textarea style="' + INP + 'min-height:70px;" id="' + id + '" data-name="' + esc(f.name) + '"></textarea>';
        if (f.type === 'dropdown') return '<select style="' + INP + '" id="' + id + '" data-name="' + esc(f.name) + '"><option value="">— select —</option>' + (f.options || []).map(function (o) { return '<option>' + esc(o) + '</option>'; }).join('') + '</select>';
        if (f.type === 'checkbox') {
            if (f.options && f.options.length) {
                return '<div data-name="' + esc(f.name) + '" data-multi="1" style="display:flex;flex-direction:column;gap:6px;">' + (f.options || []).map(function (o) {
                    return '<label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="checkbox" value="' + esc(o) + '"> ' + esc(o) + '</label>';
                }).join('') + '</div>';
            }
            return '<label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="checkbox" id="' + id + '" data-name="' + esc(f.name) + '"> Yes</label>';
        }
        var t = f.type === 'number' ? 'number' : (f.type === 'date' ? 'date' : 'text');
        return '<input type="' + t + '" style="' + INP + '" id="' + id + '" data-name="' + esc(f.name) + '">';
    }
    window.__ppxRsvpStart = function (id) {
        var c = current; if (!c || c.id !== id || !c.rsvp) return;
        track(id, 'click', 'rsvp_open', c.variant);
        var modal = backdrop && backdrop.querySelector('.ppx-modal'); var body = modal && modal.querySelector('.ppx-body'); if (!body) return;
        var th = theme(c);
        body.innerHTML = '<div class="ppx-text" style="color:' + th.text + ';">Loading…</div>';
        rsvpApi({ action: 'config', event_key: c.rsvp.event_key }).then(function (r) {
            if (!r.success) { body.innerHTML = '<div class="ppx-text" style="color:' + th.text + ';">This RSVP isn\'t available right now.</div>'; return; }
            _rsvpCfg = r.event;
            body.innerHTML = '<div class="ppx-title" style="color:' + th.title + ';">' + esc(_rsvpCfg.name || c.title || 'RSVP') + '</div>'
                + (_rsvpCfg.intro ? ('<div class="ppx-text" style="color:' + th.text + ';margin-bottom:12px;">' + bodyHtml(_rsvpCfg.intro) + '</div>') : '<div style="margin-bottom:6px;"></div>')
                + '<div style="font-size:13px;font-weight:700;color:' + th.title + ';margin-bottom:6px;">What\'s your most recent PayProTec Partner ID?</div>'
                + '<input id="ppx-rsvp-id" style="' + INP + '" placeholder="e.g. 144704" autocomplete="off">'
                + '<div id="ppx-rsvp-err" style="color:#dc2626;font-size:12px;margin-top:6px;min-height:14px;"></div>'
                + '<button type="button" class="ppx-cta" style="' + th.btn + th.btnWrap + '" onclick="__ppxRsvpLookup(\'' + jsArg(id) + '\')">Continue</button>';
            setTimeout(function () { var el = document.getElementById('ppx-rsvp-id'); if (el) el.focus(); }, 30);
        });
    };
    window.__ppxRsvpLookup = function (id) {
        var c = current; if (!c || c.id !== id || !c.rsvp) return;
        var input = document.getElementById('ppx-rsvp-id'), err = document.getElementById('ppx-rsvp-err');
        var pid = input ? input.value.trim() : '';
        if (!pid) { if (err) err.textContent = 'Please enter your Partner ID.'; return; }
        if (err) err.textContent = '';
        rsvpApi({ action: 'lookup', event_key: c.rsvp.event_key, partner_id: pid }).then(function (r) {
            if (!r.success) { if (err) err.textContent = r.message || 'Error.'; return; }
            if (r.status === 'not_found') { if (err) err.textContent = "We couldn't find that Partner ID. Please double-check it."; return; }
            if (r.status === 'not_eligible') { if (err) err.textContent = "This RSVP is exclusive to Prime49 partners."; return; }
            if (r.status === 'already_registered') { __ppxRsvpAlreadyDone(id, r.name); return; }
            _rsvpPartner = { id: pid, name: r.name, email: r.email, phone: r.phone };
            __ppxRsvpForm(id);
        });
    };
    function __ppxRsvpAlreadyDone(id, name) {
        var c = current; if (!c || c.id !== id) return;
        var modal = backdrop && backdrop.querySelector('.ppx-modal'); var body = modal && modal.querySelector('.ppx-body'); if (!body) return;
        var th = theme(c);
        body.innerHTML = '<div style="text-align:center;"><div style="font-size:34px;">✅</div><div class="ppx-title" style="margin-top:6px;color:' + th.title + ';">You\'re already registered!</div>'
            + '<div class="ppx-text" style="color:' + th.text + ';">' + esc(name || 'You') + (name ? '’ve' : ' have') + ' already RSVP\'d for this event — see you there!</div></div>';
    }
    function __ppxRsvpForm(id) {
        var c = current; if (!c || c.id !== id) return;
        var modal = backdrop && backdrop.querySelector('.ppx-modal'); var body = modal && modal.querySelector('.ppx-body'); if (!body) return;
        var th = theme(c);
        var qs = (_rsvpCfg.fields || []).map(function (f) {
            return '<div style="margin-top:12px;"><label style="display:block;font-size:12px;font-weight:700;color:' + th.text + ';margin-bottom:5px;">' + esc(f.label || f.name) + (f.required ? ' *' : '') + '</label>' + rsvpFieldInput(f) + '</div>';
        }).join('');
        body.innerHTML = '<div class="ppx-title" style="color:' + th.title + ';">' + esc(_rsvpCfg.name || c.title || 'RSVP') + '</div>'
            + '<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:11px 13px;font-size:13px;color:#0369a1;margin-top:8px;"><b>' + esc(_rsvpPartner.name || 'Partner') + '</b>' + (_rsvpPartner.email ? '<br>' + esc(_rsvpPartner.email) : '') + '</div>'
            + (qs || '<div class="ppx-text" style="color:' + th.text + ';margin-top:10px;">No extra questions — just confirm your RSVP below.</div>')
            + '<div id="ppx-rsvp-err" style="color:#dc2626;font-size:12px;margin-top:8px;min-height:14px;"></div>'
            + '<button type="button" class="ppx-cta" style="' + th.btn + th.btnWrap + '" onclick="__ppxRsvpSubmit(\'' + jsArg(id) + '\')">Confirm RSVP</button>';
    }
    window.__ppxRsvpSubmit = function (id) {
        var c = current; if (!c || c.id !== id || !_rsvpPartner) return;
        var modal = backdrop && backdrop.querySelector('.ppx-modal'); var body = modal && modal.querySelector('.ppx-body'); if (!body) return;
        var th = theme(c);
        var answers = {};
        var els = body.querySelectorAll('[data-name]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i]; var nm = el.getAttribute('data-name');
            if (el.getAttribute('data-multi') === '1') {
                var checked = el.querySelectorAll('input[type=checkbox]:checked');
                var vals = []; for (var j = 0; j < checked.length; j++) vals.push(checked[j].value);
                answers[nm] = vals;
            } else {
                answers[nm] = (el.type === 'checkbox') ? (el.checked ? 'Yes' : '') : el.value;
            }
        }
        rsvpApi({ action: 'submit', event_key: c.rsvp.event_key, partner_id: _rsvpPartner.id, email: _rsvpPartner.email, phone: _rsvpPartner.phone, answers: answers }).then(function (r) {
            var err = document.getElementById('ppx-rsvp-err');
            if (!r.success) { if (err) err.textContent = r.message || 'Something went wrong.'; return; }
            track(id, 'click', 'rsvp_submit', c.variant);
            permAdd(id); api({ action: 'dismiss', campaign_id: id });
            var embed = r.embed_url && /^https?:\/\//i.test(r.embed_url) ? r.embed_url : '';
            body.innerHTML = '<div style="text-align:center;"><div style="font-size:38px;">🎉</div><div class="ppx-title" style="margin-top:6px;color:' + th.title + ';">You\'re in!</div>'
                + '<div class="ppx-text" style="color:' + th.text + ';">' + bodyHtml(r.thankyou || "Your RSVP is confirmed. We'll see you there.") + '</div></div>'
                + (embed ? ('<div style="position:relative;width:100%;padding-top:120%;margin-top:14px;border-radius:10px;overflow:hidden;"><iframe src="' + esc(embed) + '" style="position:absolute;inset:0;width:100%;height:100%;border:0;" allow="camera; microphone; autoplay; fullscreen"></iframe></div>') : '');
        });
    };

    // Resolve a campaign's visual theme into ready-to-use inline styles.
    function theme(c) {
        var t = c.theme || {};
        var g = function (v, d) { return v || d; };
        var accent = g(t.accent, '#004990'), btnText = g(t.btnText, '#ffffff'), radius = (t.radius != null ? t.radius : 16);
        var wpx = t.width === 'narrow' ? 380 : t.width === 'wide' ? 560 : t.width === 'xwide' ? 680 : 460;
        var sizeCss = t.btnSize === 'sm' ? 'padding:9px 14px;font-size:13px;' : t.btnSize === 'lg' ? 'padding:15px 26px;font-size:16px;' : 'padding:13px 18px;font-size:14.5px;';
        var btn = (t.btnStyle === 'outline'
            ? ('background:transparent;color:' + accent + ';border:2px solid ' + accent + ';border-radius:' + radius + 'px;')
            : t.btnStyle === 'pill'
                ? ('background:' + accent + ';color:' + btnText + ';border:none;border-radius:999px;')
                : ('background:' + accent + ';color:' + btnText + ';border:none;border-radius:' + Math.min(radius, 14) + 'px;')) + sizeCss;
        // Button placement: full = block full-width; else inline aligned.
        var ba = t.btnAlign || 'full';
        var btnWrap = (ba === 'full' ? 'display:block;text-align:center;width:100%;' : 'display:inline-block;') + 'margin-top:0;';
        var btnRow = ba === 'full' ? '' : ('text-align:' + (ba === 'right' ? 'right' : ba === 'center' ? 'center' : 'left') + ';');
        return {
            modal: 'background:' + g(t.bg, '#ffffff') + ';border-radius:' + radius + 'px;width:min(' + wpx + 'px,100%);',
            title: g(t.title, '#0a1628'), text: g(t.text, '#475569'),
            align: t.align === 'center' ? 'center' : 'left',
            btn: btn, btnWrap: btnWrap, btnRow: btnRow, imgPos: t.imgPos === 'bottom' ? 'bottom' : 'top',
            overlay: t.overlay === 'light' ? 'light' : 'dark'
        };
    }

    // 'YYYY-MM-DD' → { dow, day, month, full } for the Event Hero date chip + badge.
    function heroBadgeParts(dateStr) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || ''); if (!m) return null;
        var d = new Date(+m[1], +m[2] - 1, +m[3]);
        var DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        var MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return { dow: DOW[d.getDay()], day: d.getDate(), month: MON[d.getMonth()], full: DOW[d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() };
    }
    // Event Hero — split-screen layout (dark text panel + full-bleed photo +
    // floating date badge), modeled after the nightgolf.ppt.partners page.
    function renderHero(c) {
        current = c;
        var untilAction = c.behavior === 'until_action';
        var hero = (c.theme && c.theme.hero) || {};
        var badge = heroBadgeParts(hero.event_date);
        var cid = jsArg(c.id);
        var chip = function (icon, label) { return label ? ('<div class="ppx-hero-chip"><span aria-hidden="true">' + icon + '</span>' + esc(label) + '</div>') : ''; };
        var chips = [chip('📅', badge ? badge.full : hero.event_date), chip('🕒', hero.event_time), chip('📍', hero.location)].filter(Boolean).join('');
        var ctaBtn = '';
        if (c.rsvp) ctaBtn = '<button type="button" class="ppx-hero-cta" onclick="__ppxRsvpStart(\'' + cid + '\')">' + esc(c.cta_label || 'RSVP Now') + '</button>';
        else if (c.cta_enabled && c.cta_url) {
            var fn = untilAction ? '__ppxAction' : '__ppxClick';
            ctaBtn = '<a class="ppx-hero-cta" href="' + esc(safeUrl(c.cta_url)) + '" target="_blank" rel="noopener" onclick="' + fn + '(\'' + cid + '\',\'cta\')">' + esc(c.cta_label || 'Learn more') + '</a>';
        }
        var left = '<div class="ppx-hero-left ppx-body">'
            + (hero.eyebrow ? '<div class="ppx-hero-eyebrow"><span></span>' + esc(hero.eyebrow) + '</div>' : '')
            + '<div class="ppx-hero-h1">' + esc(hero.headline1 || c.title || 'RSVP') + '</div>'
            + (hero.headline2 ? '<div class="ppx-hero-h2">' + esc(hero.headline2) + '</div>' : '')
            + (c.body_text ? '<div class="ppx-hero-body">' + bodyHtml(c.body_text) + '</div>' : '')
            + (chips ? '<div class="ppx-hero-chips">' + chips + '</div>' : '')
            + ((ctaBtn || hero.helper) ? ('<div class="ppx-hero-ctarow">' + ctaBtn + (hero.helper ? '<span class="ppx-hero-helper">' + esc(hero.helper) + '</span>' : '') + '</div>') : '')
            + '</div>';
        var right = '<div class="ppx-hero-right">'
            + (c.image_url ? '<img src="' + esc(safeUrl(c.image_url)) + '" alt="">' : '')
            + (badge ? ('<div class="ppx-hero-badge"><div class="ppx-hero-badge-dow">' + esc(badge.dow) + '</div><div class="ppx-hero-badge-day">' + badge.day + '</div><div class="ppx-hero-badge-mon">' + esc(badge.month) + '</div>'
                + ((hero.event_time || hero.location) ? ('<div class="ppx-hero-badge-sub">' + esc([hero.event_time, hero.location].filter(Boolean).join(' · ')) + '</div>') : '')
                + '</div>') : '')
            + '</div>';
        var html = '<div class="ppx-modal ppx-hero-modal"><button class="ppx-x" onclick="__ppxClose()">×</button><div class="ppx-hero-grid">' + left + right + '</div></div>';
        backdrop = document.createElement('div'); backdrop.className = 'ppx-back';
        backdrop.style.background = 'rgba(4,10,22,.7)';
        backdrop.innerHTML = html;
        // RSVP popups never auto-close on a backdrop click — an accidental
        // click shouldn't discard a Partner ID / answers already typed in.
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop && !untilAction && !c.rsvp) onClose(); });
        document.body.appendChild(backdrop);
        if (!c._impressed) { track(c.id, 'impression', null, c.variant); c._impressed = true; }
    }

    function render(c) {
        if (c.theme && c.theme.layout === 'event_hero') { injectCss(); renderHero(c); return; }
        current = c;
        var untilAction = c.behavior === 'until_action';
        var persistent = c.behavior === 'persistent';
        var dismissible = c.behavior === 'dismissible';
        // During live/replay the video takes the place of the static graphic.
        var showGraphic = (c.content_type === 'graphic' || c.content_type === 'both') && c.image_url && !c.video_url;
        var showText = (c.content_type === 'text' || c.content_type === 'both');
        var clickFn = untilAction ? '__ppxAction' : '__ppxClick';
        var cid = jsArg(c.id);

        var hot = (c.hotspots || []).filter(function (h) { return h.url; }).map(function (h) {
            return '<a class="ppx-hot" href="' + esc(safeUrl(h.url)) + '" target="_blank" rel="noopener" style="left:' + num(h.x) + '%;top:' + num(h.y) + '%;width:' + num(h.w) + '%;height:' + num(h.h) + '%;" onclick="' + clickFn + '(\'' + cid + '\',\'' + jsArg(h.id || 'hotspot') + '\')"></a>';
        }).join('');

        var th = theme(c);
        var imgBlock = showGraphic ? ('<div class="ppx-img"><img src="' + esc(safeUrl(c.image_url)) + '" alt="">' + hot + '</div>') : '';
        var inner = '';
        if (c.event_phase === 'live') inner += '<div style="display:inline-flex;align-items:center;gap:6px;background:#dc2626;color:#fff;font-size:11px;font-weight:800;letter-spacing:.5px;padding:3px 10px;border-radius:99px;margin-bottom:8px;"><span style="width:8px;height:8px;border-radius:50%;background:#fff;animation:ppxpulse 1.2s infinite;"></span>LIVE NOW</div>';
        if (showText && c.title) inner += '<div class="ppx-title" style="color:' + th.title + ';">' + esc(c.title) + '</div>';
        if (showText && c.body_text) inner += '<div class="ppx-text" style="color:' + th.text + ';">' + bodyHtml(c.body_text) + '</div>';
        // Live/replay: play the YouTube video right in the popup. The CTA below
        // still links out to YouTube for those who want to watch there.
        if (c.video_url) inner += '<div style="position:relative;width:100%;padding-top:56.25%;margin-top:14px;border-radius:10px;overflow:hidden;background:#000;"><iframe src="' + esc(safeUrl(c.video_url)) + '" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="' + esc(c.title || 'Video') + '"></iframe></div>';
        if (c.cta_enabled && c.cta_url) {
            var btnInner;
            if (c.rsvp) {
                btnInner = '<button type="button" class="ppx-cta" style="' + th.btn + th.btnWrap + '" onclick="__ppxRsvpStart(\'' + cid + '\')">' + esc(c.cta_label || 'RSVP Now') + '</button>';
            } else if (c.cta_gate && c.cta_gate.form_id) {
                btnInner = '<button type="button" class="ppx-cta" style="' + th.btn + th.btnWrap + '" onclick="__ppxGate(\'' + cid + '\')">' + esc(c.cta_label || 'Learn more') + '</button>';
            } else {
                var cta = untilAction ? '__ppxAction(\'' + cid + '\',\'cta\')' : '__ppxClick(\'' + cid + '\',\'cta\')';
                btnInner = '<a class="ppx-cta" style="' + th.btn + th.btnWrap + '" href="' + esc(safeUrl(c.cta_url)) + '" target="_blank" rel="noopener" onclick="' + cta + '">' + esc(c.cta_label || 'Learn more') + '</a>';
            }
            inner += '<div style="margin-top:14px;' + th.btnRow + '">' + btnInner + '</div>';
        }
        inner += surveyHtml(c);
        if (dismissible) inner += '<label class="ppx-forget"><input type="checkbox" onchange="if(this.checked)__ppxForget()"> Don\'t show this again</label>';
        if (queue.length) inner += '<div class="ppx-nav">' + queue.length + ' more announcement' + (queue.length > 1 ? 's' : '') + '</div>';
        var bodyBlock = '<div class="ppx-body" style="text-align:' + th.align + ';">' + inner + '</div>';

        var html = '<div class="ppx-modal" style="' + th.modal + '"><button class="ppx-x" onclick="__ppxClose()">×</button>' +
            (th.imgPos === 'bottom' ? (bodyBlock + imgBlock) : (imgBlock + bodyBlock)) + '</div>';

        backdrop = document.createElement('div'); backdrop.className = 'ppx-back';
        backdrop.style.background = th.overlay === 'light' ? 'rgba(15,23,42,.3)' : 'rgba(4,10,22,.6)';
        backdrop.innerHTML = html;
        // Clicking the dark backdrop closes (snoozes) — but not for until_action.
        // RSVP popups never auto-close on a backdrop click — an accidental
        // click shouldn't discard a Partner ID / answers already typed in.
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop && !untilAction && !c.rsvp) onClose(); });
        document.body.appendChild(backdrop);
        if (!c._impressed) { track(c.id, 'impression', null, c.variant); c._impressed = true; }
        // Video (live/replay) autoplays → track how long the popup is watched.
        if (c.video_url) startWatchTimers(c);
    }

    // ── Capture formats: sticky bar / slide-in teaser → open the full modal ──
    var teaser = null;
    function removeTeaser() { if (teaser) { teaser.remove(); teaser = null; } }
    window.__ppxTeaserOpen = function () { removeTeaser(); if (current) render(current); };
    window.__ppxTeaserClose = function () { if (current) snooze(current.id); removeTeaser(); current = null; next(); };

    function teaserButton(c) {
        var th = theme(c);
        var label = (c.cta_enabled && c.cta_label) ? c.cta_label : 'Learn more';
        return '<button class="ppx-cta" style="' + th.btn + 'padding:9px 16px;white-space:nowrap;" onclick="__ppxTeaserOpen()">' + esc(label) + '</button>';
    }
    function renderBar(c) {
        current = c; injectCss();
        teaser = document.createElement('div'); teaser.className = 'ppx-bar';
        teaser.innerHTML = '<div class="ppx-bar-in"><span class="ppx-bar-t">' + esc(c.title || 'A quick note') + '</span>' +
            teaserButton(c) + '<button class="ppx-bar-x" onclick="__ppxTeaserClose()">×</button></div>';
        document.body.appendChild(teaser);
        if (!c._impressed) { track(c.id, 'impression', null, c.variant); c._impressed = true; }
    }
    function renderSlide(c) {
        current = c; injectCss();
        var th = theme(c);
        teaser = document.createElement('div'); teaser.className = 'ppx-slide';
        teaser.innerHTML = '<button class="ppx-slide-x" onclick="__ppxTeaserClose()">×</button>' +
            '<div style="font-weight:800;font-size:15px;color:' + th.title + ';margin-bottom:6px;padding-right:16px;">' + esc(c.title || 'A quick note') + '</div>' +
            (c.body_text ? '<div style="font-size:13px;color:' + th.text + ';line-height:1.5;margin-bottom:12px;">' + bodyHtml(c.body_text).replace(/<[^>]+>/g, ' ').slice(0, 140) + '</div>' : '') +
            teaserButton(c);
        document.body.appendChild(teaser);
        if (!c._impressed) { track(c.id, 'impression', null, c.variant); c._impressed = true; }
    }

    function armExitIntent(cb) {
        var fired = false;
        function h(e) { if (!fired && e.clientY <= 0) { fired = true; document.removeEventListener('mouseout', h); cb(); } }
        document.addEventListener('mouseout', h);
        setTimeout(function () { if (!fired) { fired = true; document.removeEventListener('mouseout', h); cb(); } }, 30000); // mobile/no-mouse fallback
    }
    function present(c) {
        var f = c.embed_format || 'modal';
        if (f === 'bar') renderBar(c);
        else if (f === 'slide') renderSlide(c);
        else render(c);
    }
    function schedule(c) {
        var t = c.embed_trigger || 'load';
        if (t === 'delay') setTimeout(function () { present(c); }, Math.max(0, (c.embed_delay || 5)) * 1000);
        else if (t === 'exit') armExitIntent(function () { present(c); });
        else present(c);
    }
    function next() {
        while (queue.length) {
            var c = queue.shift();
            if (isPerm(c.id) || isSnoozed(c)) continue;
            injectCss(); schedule(c); return;
        }
    }

    var DEBUG = !!(cfg.debug) || /[?&]ppxdebug/.test(location.search);
    function log() { if (DEBUG) try { console.log.apply(console, ['[PPX]'].concat([].slice.call(arguments))); } catch (e) {} }

    function load() {
        log('loading', { api: API, site: SITE_KEY, viewer: VIEWER, ghl_location: GHL_LOC });
        api({ action: 'get_active', page: location.href }).then(function (d) {
            if (!d || !d.success) { log('endpoint error', d && d.message); return; }
            injectPixels(d.pixels);   // retargeting pixels load even if no ad shows
            if (d.excluded) { log('this page is on the site exclusion list — no announcements here.'); return; }
            if (!Array.isArray(d.data)) return;
            log('campaigns returned:', d.data.length);
            queue = d.data.filter(function (c) { return !isPerm(c.id) && !isSnoozed(c); });
            log('after snooze/dismiss filter:', queue.length);
            if (queue.length) next(); else log('nothing to show (none active/embed-enabled, or all snoozed/dismissed).');
        }).catch(function (e) { log('fetch failed (CSP/CORS/network?):', e && e.message); });
    }

    // Hash the visitor email (if any) for CAPI/Custom-Audience matching, then load.
    function boot() {
        if (EMAIL) { sha256Hex(EMAIL.trim().toLowerCase()).then(function (h) { if (h) CTX.email_sha256 = h; }).then(load, load); }
        else load();
    }
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
})();
