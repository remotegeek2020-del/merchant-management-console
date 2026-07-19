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
            '@media (max-width:520px){.ppx-back{padding:10px;align-items:flex-end;}.ppx-modal{max-height:88vh;max-height:88dvh;}.ppx-bar-in{flex-wrap:wrap;}.ppx-slide{left:12px;right:12px;width:auto;}}'
        ].join('');
        document.head.appendChild(s);
    }

    function close() { if (backdrop) { backdrop.remove(); backdrop = null; } current = null; next(); }
    function onClose() { if (current) snooze(current.id); close(); }
    function onForget() { if (current) { permAdd(current.id); track(current.id, 'dismiss', null, current.variant); api({ action: 'dismiss', campaign_id: current.id }); } close(); }
    function onAction(id, target) { permAdd(id); track(id, 'click', target || 'cta', current && current.variant); api({ action: 'dismiss', campaign_id: id }); close(); }
    function onClick(id, target) { track(id, 'click', target, current && current.variant); }
    window.__ppxClose = onClose; window.__ppxForget = onForget; window.__ppxAction = onAction; window.__ppxClick = onClick;

    // ── Interactive survey (poll / rating / contact capture) ──────────────────
    var INP = 'width:100%;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:9px;font-size:14px;font-family:inherit;box-sizing:border-box;';
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

    // Resolve a campaign's visual theme into ready-to-use inline styles.
    function theme(c) {
        var t = c.theme || {};
        var g = function (v, d) { return v || d; };
        var accent = g(t.accent, '#004990'), btnText = g(t.btnText, '#ffffff'), radius = (t.radius != null ? t.radius : 16);
        var wpx = t.width === 'narrow' ? 380 : t.width === 'wide' ? 560 : 460;
        var btn = t.btnStyle === 'outline'
            ? ('background:transparent;color:' + accent + ';border:2px solid ' + accent + ';border-radius:' + radius + 'px;')
            : t.btnStyle === 'pill'
                ? ('background:' + accent + ';color:' + btnText + ';border:none;border-radius:999px;')
                : ('background:' + accent + ';color:' + btnText + ';border:none;border-radius:' + Math.min(radius, 14) + 'px;');
        return {
            modal: 'background:' + g(t.bg, '#ffffff') + ';border-radius:' + radius + 'px;width:min(' + wpx + 'px,100%);',
            title: g(t.title, '#0a1628'), text: g(t.text, '#475569'),
            align: t.align === 'center' ? 'center' : 'left',
            btn: btn, imgPos: t.imgPos === 'bottom' ? 'bottom' : 'top',
            overlay: t.overlay === 'light' ? 'light' : 'dark'
        };
    }

    function render(c) {
        current = c;
        var untilAction = c.behavior === 'until_action';
        var persistent = c.behavior === 'persistent';
        var dismissible = c.behavior === 'dismissible';
        var showGraphic = (c.content_type === 'graphic' || c.content_type === 'both') && c.image_url;
        var showText = (c.content_type === 'text' || c.content_type === 'both');
        var clickFn = untilAction ? '__ppxAction' : '__ppxClick';
        var cid = jsArg(c.id);

        var hot = (c.hotspots || []).filter(function (h) { return h.url; }).map(function (h) {
            return '<a class="ppx-hot" href="' + esc(safeUrl(h.url)) + '" target="_blank" rel="noopener" style="left:' + num(h.x) + '%;top:' + num(h.y) + '%;width:' + num(h.w) + '%;height:' + num(h.h) + '%;" onclick="' + clickFn + '(\'' + cid + '\',\'' + jsArg(h.id || 'hotspot') + '\')"></a>';
        }).join('');

        var th = theme(c);
        var imgBlock = showGraphic ? ('<div class="ppx-img"><img src="' + esc(safeUrl(c.image_url)) + '" alt="">' + hot + '</div>') : '';
        var inner = '';
        if (showText && c.title) inner += '<div class="ppx-title" style="color:' + th.title + ';">' + esc(c.title) + '</div>';
        if (showText && c.body_text) inner += '<div class="ppx-text" style="color:' + th.text + ';">' + bodyHtml(c.body_text) + '</div>';
        if (c.cta_enabled && c.cta_url) {
            var cta = untilAction ? '__ppxAction(\'' + cid + '\',\'cta\')' : '__ppxClick(\'' + cid + '\',\'cta\')';
            inner += '<a class="ppx-cta" style="' + th.btn + '" href="' + esc(safeUrl(c.cta_url)) + '" target="_blank" rel="noopener" onclick="' + cta + '">' + esc(c.cta_label || 'Learn more') + '</a>';
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
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop && !untilAction) onClose(); });
        document.body.appendChild(backdrop);
        if (!c._impressed) { track(c.id, 'impression', null, c.variant); c._impressed = true; }
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
