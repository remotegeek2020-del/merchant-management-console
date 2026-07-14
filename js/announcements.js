/*
 * Marketing announcements — unified renderer for staff AND partner portals.
 * Loaded globally via site-config.js on every page. Dual-mode auth:
 *   • staff   → pp_session_token (Authorization: Bearer)
 *   • partner → pp_partner_token (sent in the request body)
 *
 * Three per-campaign display modes:
 *   • card_dismissible → homepage card. X = close for this browser session only
 *     (comes back next login); "Don't show again" checkbox = permanent dismiss.
 *   • card_persistent  → homepage card. No dismiss controls; always shown until
 *     the campaign expires.
 *   • floating         → small fixed-corner ad shown on EVERY page. X = close for
 *     this session; clicking the CTA (or Got it) permanently dismisses it.
 *
 * Homepage cards render into #staffAnnCarousel (staff hub) or #annCarousel
 * (partner dashboard). The floating ad is injected on every page.
 * Self-guards: no-ops without a session and on the login screen.
 */
(function () {
    'use strict';
    var STAFF_TOKEN = localStorage.getItem('pp_session_token') || '';
    var PARTNER_TOKEN = localStorage.getItem('pp_partner_token') || '';
    if (!STAFF_TOKEN && !PARTNER_TOKEN) return;              // not logged in
    if (window.__ppAnnLoaded) return; window.__ppAnnLoaded = true;

    var SESS_HIDE = 'pp_ann_hidden';                          // sessionStorage key (session-only X)
    var cardWrap = null, cardList = [], cardIdx = 0;
    var floatList = [], floatIdx = 0, floatEl = null;

    function esc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    function api(body) {
        var headers = { 'Content-Type': 'application/json' };
        if (STAFF_TOKEN) headers['Authorization'] = 'Bearer ' + STAFF_TOKEN;
        else body = Object.assign({ partner_token: PARTNER_TOKEN }, body);
        return fetch('/api/marketing', { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
    }
    function track(id, type, target) { api({ action: 'track', campaign_id: id, event_type: type, target: target || null }).catch(function () {}); }
    function dismissServer(id) { api({ action: 'dismiss', campaign_id: id }).catch(function () {}); }

    // ── session-only hide (X) ────────────────────────────────────────────────
    function sessHidden() { try { return JSON.parse(sessionStorage.getItem(SESS_HIDE) || '[]'); } catch (e) { return []; } }
    function sessHide(id) {
        try { var a = sessHidden(); if (a.indexOf(id) === -1) { a.push(id); sessionStorage.setItem(SESS_HIDE, JSON.stringify(a)); } } catch (e) {}
    }
    function isSessHidden(id) { return sessHidden().indexOf(id) !== -1; }

    // ── shared CSS ────────────────────────────────────────────────────────────
    function injectCss() {
        if (document.getElementById('pp-ann-css')) return;
        var accent = getComputedStyle(document.documentElement).getPropertyValue('--pp-blue').trim() || '#004990';
        var s = document.createElement('style'); s.id = 'pp-ann-css';
        s.textContent = [
            /* card */
            '.ppa-card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;position:relative;}',
            '.ppa-imgwrap{position:relative;display:block;line-height:0;}',
            '.ppa-imgwrap img{width:100%;display:block;}',
            '.ppa-hotspot{position:absolute;display:block;cursor:pointer;border-radius:6px;}',
            '.ppa-hotspot:hover{background:rgba(0,73,144,0.12);box-shadow:0 0 0 2px rgba(0,73,144,0.5) inset;}',
            '.ppa-body{padding:18px 20px;}',
            '.ppa-title{font-size:1.05rem;font-weight:800;color:#0a1628;margin:0 0 6px;}',
            '.ppa-text{font-size:13px;color:#475569;line-height:1.6;white-space:pre-wrap;}',
            '.ppa-cta{display:inline-flex;align-items:center;gap:6px;margin-top:14px;background:' + accent + ';color:#fff;border:none;border-radius:10px;padding:10px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:none;}',
            '.ppa-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px;border-top:1px solid #e2e8f0;background:#fafbfc;flex-wrap:wrap;}',
            '.ppa-dismiss{display:flex;align-items:center;gap:7px;font-size:12px;color:#64748b;cursor:pointer;}',
            '.ppa-nav{display:flex;align-items:center;gap:6px;font-size:12px;color:#64748b;font-weight:700;}',
            '.ppa-nav button{background:#fff;border:1px solid #e2e8f0;border-radius:8px;width:26px;height:26px;cursor:pointer;font-size:14px;line-height:1;color:#475569;}',
            '.ppa-nav button:disabled{opacity:.4;cursor:default;}',
            '.ppa-x{position:absolute;top:10px;right:10px;z-index:3;background:rgba(0,0,0,0.45);color:#fff;border:none;border-radius:50%;width:28px;height:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;}',
            /* floating */
            '.ppa-float{position:fixed;right:18px;bottom:52px;z-index:99990;width:300px;max-width:calc(100vw - 36px);background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,0.18);overflow:hidden;animation:ppaIn .35s ease;}',
            '@keyframes ppaIn{from{opacity:0;transform:translateY(12px);}to{opacity:1;transform:none;}}',
            '.ppa-float .ppa-fimg{position:relative;line-height:0;}',
            '.ppa-float .ppa-fimg img{width:100%;display:block;}',
            '.ppa-float .ppa-fbody{padding:12px 14px;}',
            '.ppa-float .ppa-ftitle{font-size:13px;font-weight:800;color:#0a1628;margin:0 0 4px;}',
            '.ppa-float .ppa-ftext{font-size:12px;color:#475569;line-height:1.5;white-space:pre-wrap;max-height:96px;overflow:auto;}',
            '.ppa-float .ppa-fcta{display:block;text-align:center;margin-top:10px;background:' + accent + ';color:#fff;border:none;border-radius:9px;padding:9px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:none;}',
            '.ppa-float .ppa-fx{position:absolute;top:8px;right:8px;z-index:3;background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:50%;width:24px;height:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;}',
            '.ppa-float .ppa-fnav{display:flex;align-items:center;justify-content:center;gap:8px;font-size:11px;color:#94a3b8;font-weight:700;padding:0 0 10px;}',
            '.ppa-float .ppa-fnav button{background:#fff;border:1px solid #e2e8f0;border-radius:7px;width:22px;height:22px;cursor:pointer;font-size:13px;line-height:1;color:#475569;}'
        ].join('');
        document.head.appendChild(s);
    }

    function hotspotHtml(c, cls) {
        return (c.hotspots || []).filter(function (h) { return h.url; }).map(function (h) {
            return '<a class="' + cls + '" href="' + esc(h.url) + '" target="_blank" rel="noopener" style="left:' + h.x + '%;top:' + h.y + '%;width:' + h.w + '%;height:' + h.h + '%;" title="' + esc(h.label || '') + '" onclick="ppAnnClick(\'' + c.id + '\',\'' + esc(h.id || 'hotspot') + '\')"></a>';
        }).join('');
    }

    // ── homepage cards ────────────────────────────────────────────────────────
    function renderCards() {
        if (!cardWrap) return;
        var visible = cardList.filter(function (c) { return !isSessHidden(c.id); });
        if (!visible.length) { cardWrap.style.display = 'none'; cardWrap.innerHTML = ''; return; }
        if (cardIdx >= visible.length) cardIdx = 0;
        var c = visible[cardIdx];
        var showGraphic = (c.content_type === 'graphic' || c.content_type === 'both') && c.image_url;
        var showText = (c.content_type === 'text' || c.content_type === 'both');
        var canDismiss = c.display_mode !== 'card_persistent';
        var html = '<div class="ppa-card">';
        if (canDismiss) html += '<button class="ppa-x" title="Close" onclick="ppAnnClose(\'' + c.id + '\')"><span class="material-icons" style="font-size:18px;">close</span></button>';
        if (showGraphic) html += '<div class="ppa-imgwrap"><img src="' + esc(c.image_url) + '" alt="' + esc(c.title) + '">' + hotspotHtml(c, 'ppa-hotspot') + '</div>';
        if (showText || (c.cta_enabled && c.cta_url)) {
            html += '<div class="ppa-body">';
            if (showText && c.title) html += '<div class="ppa-title">' + esc(c.title) + '</div>';
            if (showText && c.body_text) html += '<div class="ppa-text">' + esc(c.body_text) + '</div>';
            if (c.cta_enabled && c.cta_url) html += '<a class="ppa-cta" href="' + esc(c.cta_url) + '" target="_blank" rel="noopener" onclick="ppAnnClick(\'' + c.id + '\',\'cta\')">' + esc(c.cta_label || 'Learn more') + ' <span class="material-icons" style="font-size:16px;">arrow_forward</span></a>';
            html += '</div>';
        }
        var showFoot = (c.display_mode === 'card_dismissible') || visible.length > 1;
        if (showFoot) {
            html += '<div class="ppa-foot">';
            if (c.display_mode === 'card_dismissible') html += '<label class="ppa-dismiss"><input type="checkbox" onchange="if(this.checked)ppAnnForget(\'' + c.id + '\')"> Don\'t show this again</label>';
            else html += '<span></span>';
            if (visible.length > 1) html += '<span class="ppa-nav"><button onclick="ppAnnNav(-1)" ' + (cardIdx === 0 ? 'disabled' : '') + '>‹</button> ' + (cardIdx + 1) + ' / ' + visible.length + ' <button onclick="ppAnnNav(1)" ' + (cardIdx === visible.length - 1 ? 'disabled' : '') + '>›</button></span>';
            html += '</div>';
        }
        html += '</div>';
        cardWrap.innerHTML = html;
        cardWrap.style.display = '';
        track(c.id, 'impression');
    }

    // ── floating ad ───────────────────────────────────────────────────────────
    function renderFloat() {
        var visible = floatList.filter(function (c) { return !isSessHidden(c.id); });
        if (!visible.length) { if (floatEl) { floatEl.remove(); floatEl = null; } return; }
        if (floatIdx >= visible.length) floatIdx = 0;
        var c = visible[floatIdx];
        if (!floatEl) { floatEl = document.createElement('div'); floatEl.className = 'ppa-float'; document.body.appendChild(floatEl); }
        var showGraphic = (c.content_type === 'graphic' || c.content_type === 'both') && c.image_url;
        var showText = (c.content_type === 'text' || c.content_type === 'both');
        var html = '<button class="ppa-fx" title="Close" onclick="ppAnnClose(\'' + c.id + '\')"><span class="material-icons" style="font-size:16px;">close</span></button>';
        if (showGraphic) html += '<div class="ppa-fimg"><img src="' + esc(c.image_url) + '" alt="' + esc(c.title) + '">' + hotspotHtml(c, 'ppa-hotspot') + '</div>';
        html += '<div class="ppa-fbody">';
        if (showText && c.title) html += '<div class="ppa-ftitle">' + esc(c.title) + '</div>';
        if (showText && c.body_text) html += '<div class="ppa-ftext">' + esc(c.body_text) + '</div>';
        // Floating dismisses permanently on CTA. If no CTA, offer a "Got it" that forgets.
        if (c.cta_enabled && c.cta_url) html += '<a class="ppa-fcta" href="' + esc(c.cta_url) + '" target="_blank" rel="noopener" onclick="ppAnnCtaDone(\'' + c.id + '\')">' + esc(c.cta_label || 'Learn more') + '</a>';
        else html += '<button class="ppa-fcta" onclick="ppAnnForget(\'' + c.id + '\')">Got it</button>';
        html += '</div>';
        if (visible.length > 1) html += '<div class="ppa-fnav"><button onclick="ppAnnFloatNav(-1)">‹</button> ' + (floatIdx + 1) + ' / ' + visible.length + ' <button onclick="ppAnnFloatNav(1)">›</button></div>';
        floatEl.innerHTML = html;
        track(c.id, 'impression');
    }

    // ── global handlers ───────────────────────────────────────────────────────
    window.ppAnnClick = function (id, t) { track(id, 'click', t); };
    window.ppAnnNav = function (d) {
        var visible = cardList.filter(function (c) { return !isSessHidden(c.id); });
        cardIdx = Math.max(0, Math.min(visible.length - 1, cardIdx + d)); renderCards();
    };
    window.ppAnnFloatNav = function (d) {
        var visible = floatList.filter(function (c) { return !isSessHidden(c.id); });
        floatIdx = Math.max(0, Math.min(visible.length - 1, floatIdx + d)); renderFloat();
    };
    // X: close for this browser session only (returns next login). No server call.
    window.ppAnnClose = function (id) { sessHide(id); renderCards(); renderFloat(); };
    // Checkbox / "Got it": permanent dismiss for this user.
    window.ppAnnForget = function (id) { dismissServer(id); track(id, 'dismiss'); removeEverywhere(id); };
    // Floating CTA clicked: count the click AND permanently dismiss.
    window.ppAnnCtaDone = function (id) { track(id, 'click', 'cta'); dismissServer(id); removeEverywhere(id); };

    function removeEverywhere(id) {
        cardList = cardList.filter(function (c) { return c.id !== id; });
        floatList = floatList.filter(function (c) { return c.id !== id; });
        renderCards(); renderFloat();
    }

    function boot(data) {
        var all = Array.isArray(data) ? data : [];
        if (!all.length) return;
        injectCss();
        cardWrap = document.getElementById('staffAnnCarousel') || document.getElementById('annCarousel');
        all.forEach(function (c) {
            if (c.display_mode === 'floating') floatList.push(c);
            else if (cardWrap) cardList.push(c);   // card modes only render where a carousel exists
        });
        renderCards();
        renderFloat();
    }

    function load() {
        api({ action: 'get_active' }).then(function (d) {
            if (d && d.success) boot(d.data);
        }).catch(function () {});
    }

    if (document.readyState !== 'loading') load();
    else document.addEventListener('DOMContentLoaded', load);
})();
