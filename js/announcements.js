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
 *   • floating_dismissible → small fixed-corner ad on EVERY page. X = close for
 *     this session; clicking the CTA (or "Don't show again") permanently hides it.
 *   • floating_persistent  → same floating ad, but it always returns until the
 *     campaign expires. X only closes it for the session; the CTA just opens the
 *     link (no permanent dismiss).
 *   • both_dismissible / both_persistent → shown as a homepage card AND a
 *     floating ad at the same time, with the matching dismiss behavior.
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

    var SNOOZE_KEY = 'pp_ann_snooze';                         // localStorage: {id: epochMs closed}
    var FREQ_MS = 5 * 60 * 1000;                              // re-show a closed ad after 5 minutes
    var cardWrap = null, cardList = [], cardIdx = 0;
    var floatList = [], floatIdx = 0, floatEl = null;
    var shownCardId = null, shownFloatId = null;             // to avoid re-tracking impressions

    function esc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    function api(body) {
        var headers = { 'Content-Type': 'application/json' };
        if (STAFF_TOKEN) headers['Authorization'] = 'Bearer ' + STAFF_TOKEN;
        else body = Object.assign({ partner_token: PARTNER_TOKEN }, body);
        return fetch('/api/marketing', { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
    }
    function track(id, type, target) { api({ action: 'track', campaign_id: id, event_type: type, target: target || null }).catch(function () {}); }
    function dismissServer(id) { api({ action: 'dismiss', campaign_id: id }).catch(function () {}); }

    // ── snooze (X / CTA close) ───────────────────────────────────────────────
    // Closing an ad only hides it temporarily; it re-shows after FREQ_MS. Only the
    // "Don't show again" checkbox hides it permanently (server-side dismiss).
    function snoozeMap() { try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}'); } catch (e) { return {}; } }
    function snooze(id) { try { var m = snoozeMap(); m[id] = Date.now(); localStorage.setItem(SNOOZE_KEY, JSON.stringify(m)); } catch (e) {} }
    function isSnoozed(id) { var m = snoozeMap(); return m[id] && (Date.now() - m[id]) < FREQ_MS; }

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
            '.ppa-float .ppa-fcta{display:block;text-align:center;margin-top:10px;background:' + accent + ';color:#fff;border:none;border-radius:9px;padding:9px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:none;width:100%;}',
            '.ppa-float .ppa-fforget{display:flex;align-items:center;gap:6px;margin-top:9px;font-size:11px;color:#94a3b8;cursor:pointer;}',
            '.ppa-float .ppa-fx{position:absolute;top:8px;right:8px;z-index:3;background:rgba(0,0,0,0.5);color:#fff;border:none;border-radius:50%;width:24px;height:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;}',
            '.ppa-float .ppa-fnav{display:flex;align-items:center;justify-content:center;gap:8px;font-size:11px;color:#94a3b8;font-weight:700;padding:0 0 10px;}',
            '.ppa-float .ppa-fnav button{background:#fff;border:1px solid #e2e8f0;border-radius:7px;width:22px;height:22px;cursor:pointer;font-size:13px;line-height:1;color:#475569;}'
        ].join('');
        document.head.appendChild(s);
    }

    function isUntilAction(c) { return /until_action$/.test(c.display_mode || ''); }

    function hotspotHtml(c, cls) {
        // In "until action" mode, clicking a hotspot IS the action → permanent dismiss.
        var fn = isUntilAction(c) ? 'ppAnnAction' : 'ppAnnClick';
        return (c.hotspots || []).filter(function (h) { return h.url; }).map(function (h) {
            return '<a class="' + cls + '" href="' + esc(h.url) + '" target="_blank" rel="noopener" style="left:' + h.x + '%;top:' + h.y + '%;width:' + h.w + '%;height:' + h.h + '%;" title="' + esc(h.label || '') + '" onclick="' + fn + '(\'' + c.id + '\',\'' + esc(h.id || 'hotspot') + '\')"></a>';
        }).join('');
    }

    // ── homepage cards ────────────────────────────────────────────────────────
    function renderCards() {
        if (!cardWrap) return;
        var visible = cardList.filter(function (c) { return !isSnoozed(c.id); });
        if (!visible.length) { cardWrap.style.display = 'none'; cardWrap.innerHTML = ''; shownCardId = null; return; }
        if (cardIdx >= visible.length) cardIdx = 0;
        var c = visible[cardIdx];
        // Already showing this exact card → don't re-render (avoids flicker + re-tracking).
        if (shownCardId === c.id && cardWrap.firstChild) return;
        var showGraphic = (c.content_type === 'graphic' || c.content_type === 'both') && c.image_url;
        var showText = (c.content_type === 'text' || c.content_type === 'both');
        var dismissible = /dismissible$/.test(c.display_mode || '');
        var persistent = /persistent$/.test(c.display_mode || '');
        var untilAction = isUntilAction(c);
        var canDismiss = !persistent;   // persistent has no close; dismissible + until_action snooze via X
        var ctaFn = untilAction ? 'ppAnnAction' : 'ppAnnClick';
        var html = '<div class="ppa-card">';
        if (canDismiss) html += '<button class="ppa-x" title="Close" onclick="ppAnnClose(\'' + c.id + '\')"><span class="material-icons" style="font-size:18px;">close</span></button>';
        if (showGraphic) html += '<div class="ppa-imgwrap"><img src="' + esc(c.image_url) + '" alt="' + esc(c.title) + '">' + hotspotHtml(c, 'ppa-hotspot') + '</div>';
        if (showText || (c.cta_enabled && c.cta_url)) {
            html += '<div class="ppa-body">';
            if (showText && c.title) html += '<div class="ppa-title">' + esc(c.title) + '</div>';
            if (showText && c.body_text) html += '<div class="ppa-text">' + esc(c.body_text) + '</div>';
            if (c.cta_enabled && c.cta_url) html += '<a class="ppa-cta" href="' + esc(c.cta_url) + '" target="_blank" rel="noopener" onclick="' + ctaFn + '(\'' + c.id + '\',\'cta\')">' + esc(c.cta_label || 'Learn more') + ' <span class="material-icons" style="font-size:16px;">arrow_forward</span></a>';
            html += '</div>';
        }
        var showFoot = dismissible || visible.length > 1;
        if (showFoot) {
            html += '<div class="ppa-foot">';
            if (dismissible) html += '<label class="ppa-dismiss"><input type="checkbox" onchange="if(this.checked)ppAnnForget(\'' + c.id + '\')"> Don\'t show this again</label>';
            else html += '<span></span>';
            if (visible.length > 1) html += '<span class="ppa-nav"><button onclick="ppAnnNav(-1)" ' + (cardIdx === 0 ? 'disabled' : '') + '>‹</button> ' + (cardIdx + 1) + ' / ' + visible.length + ' <button onclick="ppAnnNav(1)" ' + (cardIdx === visible.length - 1 ? 'disabled' : '') + '>›</button></span>';
            html += '</div>';
        }
        html += '</div>';
        cardWrap.innerHTML = html;
        cardWrap.style.display = '';
        if (shownCardId !== c.id) { shownCardId = c.id; track(c.id, 'impression'); }
    }

    // ── floating ad ───────────────────────────────────────────────────────────
    function floatVisible() {
        // Don't float a campaign that is already shown as a card on THIS page.
        var cardIds = {}; cardList.forEach(function (c) { cardIds[c.id] = 1; });
        return floatList.filter(function (c) { return !cardIds[c.id] && !isSnoozed(c.id); });
    }

    function renderFloat() {
        var visible = floatVisible();
        if (!visible.length) { if (floatEl) { floatEl.remove(); floatEl = null; } shownFloatId = null; return; }
        if (floatIdx >= visible.length) floatIdx = 0;
        var c = visible[floatIdx];
        // Already showing this exact ad → leave it (avoids flicker + re-tracking).
        if (floatEl && shownFloatId === c.id) return;
        if (!floatEl) { floatEl = document.createElement('div'); floatEl.className = 'ppa-float'; document.body.appendChild(floatEl); }
        var dismissible = /dismissible$/.test(c.display_mode || '');
        var untilAction = isUntilAction(c);
        var showGraphic = (c.content_type === 'graphic' || c.content_type === 'both') && c.image_url;
        var showText = (c.content_type === 'text' || c.content_type === 'both');
        var html = '<button class="ppa-fx" title="Close" onclick="ppAnnClose(\'' + c.id + '\')"><span class="material-icons" style="font-size:16px;">close</span></button>';
        if (showGraphic) html += '<div class="ppa-fimg"><img src="' + esc(c.image_url) + '" alt="' + esc(c.title) + '">' + hotspotHtml(c, 'ppa-hotspot') + '</div>';
        html += '<div class="ppa-fbody">';
        if (showText && c.title) html += '<div class="ppa-ftitle">' + esc(c.title) + '</div>';
        if (showText && c.body_text) html += '<div class="ppa-ftext">' + esc(c.body_text) + '</div>';
        // until_action: CTA click is the action → permanent dismiss. Others: click
        // just opens the link + counts, then snoozes (re-shows later).
        if (c.cta_enabled && c.cta_url) {
            var onCta = untilAction ? 'ppAnnAction(\'' + c.id + '\',\'cta\')' : 'ppAnnCta(\'' + c.id + '\')';
            html += '<a class="ppa-fcta" href="' + esc(c.cta_url) + '" target="_blank" rel="noopener" onclick="' + onCta + '">' + esc(c.cta_label || 'Learn more') + '</a>';
        }
        // Only dismissible ads offer a permanent opt-out checkbox.
        if (dismissible) html += '<label class="ppa-fforget"><input type="checkbox" onchange="if(this.checked)ppAnnForget(\'' + c.id + '\')"> Don\'t show this again</label>';
        html += '</div>';
        if (visible.length > 1) html += '<div class="ppa-fnav"><button onclick="ppAnnFloatNav(-1)">‹</button> ' + (floatIdx + 1) + ' / ' + visible.length + ' <button onclick="ppAnnFloatNav(1)">›</button></div>';
        floatEl.innerHTML = html;
        if (shownFloatId !== c.id) { shownFloatId = c.id; track(c.id, 'impression'); }
    }

    // ── global handlers ───────────────────────────────────────────────────────
    window.ppAnnClick = function (id, t) { track(id, 'click', t); };
    window.ppAnnNav = function (d) {
        var visible = cardList.filter(function (c) { return !isSnoozed(c.id); });
        cardIdx = Math.max(0, Math.min(visible.length - 1, cardIdx + d)); shownCardId = null; renderCards();
    };
    window.ppAnnFloatNav = function (d) {
        var visible = floatVisible();
        floatIdx = Math.max(0, Math.min(visible.length - 1, floatIdx + d)); shownFloatId = null; renderFloat();
    };
    // X: close for now — snoozes for FREQ_MS, then it re-shows automatically.
    window.ppAnnClose = function (id) { snooze(id); shownCardId = null; shownFloatId = null; renderCards(); renderFloat(); };
    // CTA on a floating ad: count the click, open the link, and snooze (re-shows later).
    window.ppAnnCta = function (id) { track(id, 'click', 'cta'); snooze(id); shownFloatId = null; setTimeout(renderFloat, 50); };
    // "Don't show again" checkbox: the ONLY permanent dismiss.
    window.ppAnnForget = function (id) { dismissServer(id); track(id, 'dismiss'); removeEverywhere(id); };
    // "Until they click an action" mode: clicking the CTA/hotspot counts the
    // click AND permanently dismisses (the action is the goal).
    window.ppAnnAction = function (id, target) { track(id, 'click', target || 'cta'); dismissServer(id); removeEverywhere(id); };

    function removeEverywhere(id) {
        cardList = cardList.filter(function (c) { return c.id !== id; });
        floatList = floatList.filter(function (c) { return c.id !== id; });
        shownCardId = null; shownFloatId = null;
        renderCards(); renderFloat();
    }

    var REFRESH_MS = 3 * 60 * 1000;    // re-poll get_active so mid-day campaigns appear without a reload
    var started = false;

    // Rebuild the card/float lists from a fresh get_active payload. Snooze state
    // lives in localStorage and dismissed ones are already filtered server-side,
    // so it's safe to rebuild wholesale.
    function applyData(data) {
        var all = Array.isArray(data) ? data : [];
        cardWrap = document.getElementById('staffAnnCarousel') || document.getElementById('annCarousel');
        var newCards = [], newFloat = [];
        all.forEach(function (c) {
            var m = c.display_mode || 'card_dismissible';
            var asFloat = m.indexOf('floating') === 0 || m.indexOf('both') === 0;
            var asCard = m.indexOf('card') === 0 || m.indexOf('both') === 0;
            if (asFloat) newFloat.push(c);
            if (asCard && cardWrap) newCards.push(c);   // cards only render where a carousel exists
        });
        // If the currently shown item is gone from the new set, force a re-render.
        if (!newCards.some(function (c) { return c.id === shownCardId; })) shownCardId = null;
        if (!newFloat.some(function (c) { return c.id === shownFloatId; })) shownFloatId = null;
        cardList = newCards; floatList = newFloat;
        if (cardIdx >= cardList.length) cardIdx = 0;
        if (floatIdx >= floatList.length) floatIdx = 0;
        if (all.length) injectCss();
        renderCards();
        renderFloat();
    }

    function startTimers() {
        if (started) return; started = true;
        // Fast tick: re-show snoozed ads once their window passes (no network).
        setInterval(function () { renderCards(); renderFloat(); }, 30 * 1000);
        // Slow tick: pull newly created / edited campaigns so they appear live.
        setInterval(load, REFRESH_MS);
    }

    function load() {
        api({ action: 'get_active' }).then(function (d) {
            if (d && d.success) { applyData(d.data); startTimers(); }
        }).catch(function () {});
    }

    if (document.readyState !== 'loading') load();
    else document.addEventListener('DOMContentLoaded', load);
})();
