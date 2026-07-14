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
    var SITE_KEY = cfg.siteKey || cfg.site_key || attr('data-site-key') || '';
    var EMAIL = String(cfg.email || attr('data-email') || '').trim();
    var ACCOUNT = String(cfg.account || attr('data-account') || '').trim();
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
    function api(body) {
        body.site_key = SITE_KEY; body.viewer_id = VIEWER; if (GHL_LOC) body.ghl_location = GHL_LOC;
        return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).catch(function () { return { success: false }; });
    }
    function track(id, type, target, variant) { api({ action: 'track', campaign_id: id, event_type: type, target: target || null, variant: variant || null }); }

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
            // Phones: dock to the bottom as a sheet, nearly full width.
            '@media (max-width:520px){.ppx-back{padding:10px;align-items:flex-end;}.ppx-modal{max-height:88vh;max-height:88dvh;}}'
        ].join('');
        document.head.appendChild(s);
    }

    function close() { if (backdrop) { backdrop.remove(); backdrop = null; } current = null; next(); }
    function onClose() { if (current) snooze(current.id); close(); }
    function onForget() { if (current) { permAdd(current.id); track(current.id, 'dismiss', null, current.variant); api({ action: 'dismiss', campaign_id: current.id }); } close(); }
    function onAction(id, target) { permAdd(id); track(id, 'click', target || 'cta', current && current.variant); api({ action: 'dismiss', campaign_id: id }); close(); }
    function onClick(id, target) { track(id, 'click', target, current && current.variant); }
    window.__ppxClose = onClose; window.__ppxForget = onForget; window.__ppxAction = onAction; window.__ppxClick = onClick;

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

        var html = '<div class="ppx-modal">';
        html += '<button class="ppx-x" onclick="__ppxClose()">×</button>';
        if (showGraphic) html += '<div class="ppx-img"><img src="' + esc(safeUrl(c.image_url)) + '" alt="">' + hot + '</div>';
        html += '<div class="ppx-body">';
        if (showText && c.title) html += '<div class="ppx-title">' + esc(c.title) + '</div>';
        if (showText && c.body_text) html += '<div class="ppx-text">' + bodyHtml(c.body_text) + '</div>';
        if (c.cta_enabled && c.cta_url) {
            var cta = untilAction ? '__ppxAction(\'' + cid + '\',\'cta\')' : '__ppxClick(\'' + cid + '\',\'cta\')';
            html += '<a class="ppx-cta" href="' + esc(safeUrl(c.cta_url)) + '" target="_blank" rel="noopener" onclick="' + cta + '">' + esc(c.cta_label || 'Learn more') + '</a>';
        }
        if (dismissible) html += '<label class="ppx-forget"><input type="checkbox" onchange="if(this.checked)__ppxForget()"> Don\'t show this again</label>';
        if (queue.length) html += '<div class="ppx-nav">' + queue.length + ' more announcement' + (queue.length > 1 ? 's' : '') + '</div>';
        html += '</div></div>';

        backdrop = document.createElement('div'); backdrop.className = 'ppx-back';
        backdrop.innerHTML = html;
        // Clicking the dark backdrop closes (snoozes) — but not for until_action.
        backdrop.addEventListener('click', function (e) { if (e.target === backdrop && !untilAction) onClose(); });
        document.body.appendChild(backdrop);
        track(c.id, 'impression', null, c.variant);
    }

    function next() {
        while (queue.length) {
            var c = queue.shift();
            if (isPerm(c.id) || isSnoozed(c)) continue;
            injectCss(); render(c); return;
        }
    }

    var DEBUG = !!(cfg.debug) || /[?&]ppxdebug/.test(location.search);
    function log() { if (DEBUG) try { console.log.apply(console, ['[PPX]'].concat([].slice.call(arguments))); } catch (e) {} }

    function load() {
        log('loading', { api: API, site: SITE_KEY, viewer: VIEWER, ghl_location: GHL_LOC });
        api({ action: 'get_active' }).then(function (d) {
            if (!d || !d.success) { log('endpoint error', d && d.message); return; }
            if (!Array.isArray(d.data)) return;
            log('campaigns returned:', d.data.length);
            queue = d.data.filter(function (c) { return !isPerm(c.id) && !isSnoozed(c); });
            log('after snooze/dismiss filter:', queue.length);
            if (queue.length) next(); else log('nothing to show (none active/embed-enabled, or all snoozed/dismissed).');
        }).catch(function (e) { log('fetch failed (CSP/CORS/network?):', e && e.message); });
    }

    if (document.readyState !== 'loading') load();
    else document.addEventListener('DOMContentLoaded', load);
})();
