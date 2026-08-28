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
    var PERM_KEY = 'pp_ann_dismissed';                        // localStorage: [ids] permanently dismissed
    var DEFAULT_FREQ_MIN = 5;                                 // fallback re-show cadence (minutes)
    var cardWrap = null, cardList = [], cardIdx = 0;
    var floatList = [], floatIdx = 0, floatEl = null;
    var shownCardId = null, shownFloatId = null;             // to avoid re-tracking impressions

    function esc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function safeUrl(u) { u = String(u == null ? '' : u).trim(); return /^(https?:|mailto:|tel:|\/|#)/i.test(u) ? u : '#'; }
    function num(n) { n = parseFloat(n); return isFinite(n) ? n : 0; }
    function jsArg(s) { return String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, ''); }
    function bodyHtml(b) { b = b == null ? '' : String(b); return /<[a-z][\s\S]*>/i.test(b) ? b : esc(b).replace(/\n/g, '<br>'); }

    function api(body) {
        var headers = { 'Content-Type': 'application/json' };
        if (STAFF_TOKEN) headers['Authorization'] = 'Bearer ' + STAFF_TOKEN;
        else body = Object.assign({ partner_token: PARTNER_TOKEN }, body);
        return fetch('/api/marketing', { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
    }
    var variantMap = {};   // campaign id → 'A' | 'B' | null (for A/B stats attribution)
    function track(id, type, target) { api({ action: 'track', campaign_id: id, event_type: type, target: target || null, variant: variantMap[id] || null }).catch(function () {}); }
    // ── Watch-time milestones for live/replay video cards ──
    var _annWatch = [];
    function clearAnnWatch() { _annWatch.forEach(clearTimeout); _annWatch = []; }
    function startAnnWatch(id) {
        clearAnnWatch();
        _annWatch.push(setTimeout(function () { track(id, 'watch', 'w10'); }, 10000));
        _annWatch.push(setTimeout(function () { track(id, 'watch', 'w60'); }, 60000));
        _annWatch.push(setTimeout(function () { track(id, 'watch', 'wlong'); }, 300000));
    }
    function dismissServer(id) { api({ action: 'dismiss', campaign_id: id }).catch(function () {}); }

    // ── snooze (X / CTA close) ───────────────────────────────────────────────
    // Closing an ad only hides it temporarily; it re-shows after the campaign's
    // own re-show frequency (reshow_minutes). Only the "Don't show again" checkbox
    // hides it permanently (server-side dismiss).
    function snoozeMap() { try { return JSON.parse(localStorage.getItem(SNOOZE_KEY) || '{}'); } catch (e) { return {}; } }
    function snooze(id) { try { var m = snoozeMap(); m[id] = Date.now(); localStorage.setItem(SNOOZE_KEY, JSON.stringify(m)); } catch (e) {} }
    function freqMs(c) { var n = c && +c.reshow_minutes; return (isFinite(n) && n > 0 ? n : DEFAULT_FREQ_MIN) * 60 * 1000; }
    function isSnoozed(c) { var m = snoozeMap(); return m[c.id] && (Date.now() - m[c.id]) < freqMs(c); }

    // Permanent dismiss (checkbox / "until action" click) — remembered locally so the
    // ad never returns on this browser, independent of server round-trips / re-polls.
    function permList() { try { return JSON.parse(localStorage.getItem(PERM_KEY) || '[]'); } catch (e) { return []; } }
    function permAdd(id) { try { var a = permList(); if (a.indexOf(id) === -1) { a.push(id); localStorage.setItem(PERM_KEY, JSON.stringify(a)); } } catch (e) {} }
    function isPerm(id) { return permList().indexOf(id) !== -1; }

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
            '.ppa-text{font-size:13px;color:#475569;line-height:1.6;}',
            '.ppa-text p{margin:0 0 8px;}.ppa-text p:last-child{margin-bottom:0;}.ppa-text a{color:var(--pp-blue,#004990);}.ppa-text ul,.ppa-text ol{margin:0 0 8px;padding-left:20px;}',
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
            '@keyframes ppaPulse{0%{opacity:1;}50%{opacity:.35;}100%{opacity:1;}}',
            '.ppa-float .ppa-fimg{position:relative;line-height:0;}',
            '.ppa-float .ppa-fimg img{width:100%;display:block;}',
            '.ppa-float .ppa-fbody{padding:12px 14px;}',
            '.ppa-float .ppa-ftitle{font-size:13px;font-weight:800;color:#0a1628;margin:0 0 4px;}',
            '.ppa-float .ppa-ftext{font-size:12px;color:#475569;line-height:1.5;max-height:96px;overflow:auto;}',
            '.ppa-ftext p{margin:0 0 6px;}.ppa-ftext p:last-child{margin-bottom:0;}.ppa-ftext a{color:var(--pp-blue,#004990);}',
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
        var cid = jsArg(c.id);
        return (c.hotspots || []).filter(function (h) { return h.url; }).map(function (h) {
            return '<a class="' + cls + '" href="' + esc(safeUrl(h.url)) + '" target="_blank" rel="noopener" style="left:' + num(h.x) + '%;top:' + num(h.y) + '%;width:' + num(h.w) + '%;height:' + num(h.h) + '%;" title="' + esc(h.label || '') + '" onclick="' + fn + '(\'' + cid + '\',\'' + jsArg(h.id || 'hotspot') + '\')"></a>';
        }).join('');
    }

    // ── homepage cards ────────────────────────────────────────────────────────
    function annTheme(c) {
        var t = c.theme || {};
        var g = function (v, d) { return v || d; };
        var accent = g(t.accent, '#004990'), btnText = g(t.btnText, '#ffffff'), radius = (t.radius != null ? t.radius : 16);
        var sizeCss = t.btnSize === 'sm' ? 'padding:8px 14px;font-size:12px;' : t.btnSize === 'lg' ? 'padding:14px 24px;font-size:15px;' : 'padding:10px 18px;font-size:13px;';
        var btn = (t.btnStyle === 'outline'
            ? ('background:transparent;color:' + accent + ';border:2px solid ' + accent + ';border-radius:' + radius + 'px;')
            : t.btnStyle === 'pill'
                ? ('background:' + accent + ';color:' + btnText + ';border:none;border-radius:999px;')
                : ('background:' + accent + ';color:' + btnText + ';border:none;border-radius:' + Math.min(radius, 14) + 'px;')) + sizeCss;
        var ba = t.btnAlign || 'full';
        var btnWrap = (ba === 'full' ? 'display:block;text-align:center;width:100%;' : 'display:inline-flex;') + 'margin-top:0;';
        var btnRow = ba === 'full' ? '' : ('text-align:' + (ba === 'right' ? 'right' : ba === 'center' ? 'center' : 'left') + ';');
        return {
            card: 'background:' + g(t.bg, '#ffffff') + ';border-radius:' + radius + 'px;',
            title: g(t.title, '#0a1628'), text: g(t.text, '#475569'),
            align: t.align === 'center' ? 'center' : 'left', btn: btn, btnWrap: btnWrap, btnRow: btnRow
        };
    }

    function renderCards() {
        if (!cardWrap) return;
        var visible = cardList.filter(function (c) { return !isPerm(c.id) && !isSnoozed(c); });
        if (!visible.length) { cardWrap.style.display = 'none'; cardWrap.innerHTML = ''; shownCardId = null; clearAnnWatch(); return; }
        if (cardIdx >= visible.length) cardIdx = 0;
        var c = visible[cardIdx];
        // Already showing this exact card → don't re-render (avoids flicker + re-tracking).
        if (shownCardId === c.id && cardWrap.firstChild) return;
        // During live/replay the video takes the place of the static graphic.
        var showGraphic = (c.content_type === 'graphic' || c.content_type === 'both') && c.image_url && !c.video_url;
        var showText = (c.content_type === 'text' || c.content_type === 'both');
        var dismissible = /dismissible$/.test(c.display_mode || '');
        var persistent = /persistent$/.test(c.display_mode || '');
        var untilAction = isUntilAction(c);
        var canDismiss = !persistent;   // persistent has no close; dismissible + until_action snooze via X
        var ctaFn = untilAction ? 'ppAnnAction' : 'ppAnnClick';
        var th = annTheme(c);
        var html = '<div class="ppa-card" style="' + th.card + '">';
        if (canDismiss) html += '<button class="ppa-x" title="Close" onclick="ppAnnClose(\'' + c.id + '\')"><span class="material-icons" style="font-size:18px;">close</span></button>';
        if (showGraphic) html += '<div class="ppa-imgwrap"><img src="' + esc(safeUrl(c.image_url)) + '" alt="' + esc(c.title) + '">' + hotspotHtml(c, 'ppa-hotspot') + '</div>';
        var hasSurvey = c.survey && c.survey.enabled;
        if (showText || (c.cta_enabled && c.cta_url) || hasSurvey || c.video_url) {
            html += '<div class="ppa-body" style="text-align:' + th.align + ';">';
            if (c.event_phase === 'live') html += '<div style="display:inline-flex;align-items:center;gap:6px;background:#dc2626;color:#fff;font-size:11px;font-weight:800;letter-spacing:.5px;padding:3px 10px;border-radius:99px;margin-bottom:8px;"><span style="width:8px;height:8px;border-radius:50%;background:#fff;animation:ppaPulse 1.2s infinite;"></span>LIVE NOW</div>';
            if (showText && c.title) html += '<div class="ppa-title" style="color:' + th.title + ';">' + esc(c.title) + '</div>';
            if (showText && c.body_text) html += '<div class="ppa-text" style="color:' + th.text + ';">' + bodyHtml(c.body_text) + '</div>';
            // Live/replay: play the YouTube video inside the card; CTA still links out.
            if (c.video_url) html += '<div style="position:relative;width:100%;padding-top:56.25%;margin-top:14px;border-radius:10px;overflow:hidden;background:#000;"><iframe src="' + esc(safeUrl(c.video_url)) + '" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="' + esc(c.title || 'Video') + '"></iframe></div>';
            if (c.cta_enabled && c.cta_url) html += '<div style="margin-top:14px;' + th.btnRow + '"><a class="ppa-cta" style="' + th.btn + th.btnWrap + '" href="' + esc(safeUrl(c.cta_url)) + '" target="_blank" rel="noopener" onclick="' + ctaFn + '(\'' + jsArg(c.id) + '\',\'cta\')">' + esc(c.cta_label || 'Learn more') + ' <span class="material-icons" style="font-size:16px;">arrow_forward</span></a></div>';
            html += surveyHtml(c);
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
        if (shownCardId !== c.id) { shownCardId = c.id; track(c.id, 'impression'); if (c.video_url) startAnnWatch(c.id); else clearAnnWatch(); }
    }

    // ── floating ad ───────────────────────────────────────────────────────────
    function floatVisible() {
        // Don't float a campaign that is already shown as a card on THIS page.
        var cardIds = {}; cardList.forEach(function (c) { cardIds[c.id] = 1; });
        return floatList.filter(function (c) { return !cardIds[c.id] && !isPerm(c.id) && !isSnoozed(c); });
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
        var fcid = jsArg(c.id);
        var html = '<button class="ppa-fx" title="Close" onclick="ppAnnClose(\'' + fcid + '\')"><span class="material-icons" style="font-size:16px;">close</span></button>';
        if (showGraphic) html += '<div class="ppa-fimg"><img src="' + esc(safeUrl(c.image_url)) + '" alt="' + esc(c.title) + '">' + hotspotHtml(c, 'ppa-hotspot') + '</div>';
        html += '<div class="ppa-fbody">';
        if (showText && c.title) html += '<div class="ppa-ftitle">' + esc(c.title) + '</div>';
        if (showText && c.body_text) html += '<div class="ppa-ftext">' + bodyHtml(c.body_text) + '</div>';
        // until_action: CTA click is the action → permanent dismiss. Others: click
        // just opens the link + counts, then snoozes (re-shows later).
        if (c.cta_enabled && c.cta_url) {
            var onCta = untilAction ? 'ppAnnAction(\'' + fcid + '\',\'cta\')' : 'ppAnnCta(\'' + fcid + '\')';
            html += '<a class="ppa-fcta" href="' + esc(safeUrl(c.cta_url)) + '" target="_blank" rel="noopener" onclick="' + onCta + '">' + esc(c.cta_label || 'Learn more') + '</a>';
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
        var visible = cardList.filter(function (c) { return !isPerm(c.id) && !isSnoozed(c); });
        cardIdx = Math.max(0, Math.min(visible.length - 1, cardIdx + d)); shownCardId = null; renderCards();
    };
    window.ppAnnFloatNav = function (d) {
        var visible = floatVisible();
        floatIdx = Math.max(0, Math.min(visible.length - 1, floatIdx + d)); shownFloatId = null; renderFloat();
    };
    // X: close for now — snoozes for FREQ_MS, then it re-shows automatically.
    window.ppAnnClose = function (id) { clearAnnWatch(); snooze(id); shownCardId = null; shownFloatId = null; renderCards(); renderFloat(); };
    // CTA on a floating ad: count the click, open the link, and snooze (re-shows later).
    window.ppAnnCta = function (id) { track(id, 'click', 'cta'); snooze(id); shownFloatId = null; setTimeout(renderFloat, 50); };
    // "Don't show again" checkbox: the ONLY permanent dismiss.
    window.ppAnnForget = function (id) { permAdd(id); dismissServer(id); track(id, 'dismiss'); removeEverywhere(id); };
    // "Until they click an action" mode: clicking the CTA/hotspot counts the
    // click AND permanently dismisses (the action is the goal).
    window.ppAnnAction = function (id, target) { permAdd(id); track(id, 'click', target || 'cta'); dismissServer(id); removeEverywhere(id); };

    function removeEverywhere(id) {
        cardList = cardList.filter(function (c) { return c.id !== id; });
        floatList = floatList.filter(function (c) { return c.id !== id; });
        shownCardId = null; shownFloatId = null;
        renderCards(); renderFloat();
    }

    // ── Interactive survey (poll / rating / contact capture) ──────────────────
    var SVINP = 'width:100%;padding:9px 11px;border:1.5px solid #e2e8f0;border-radius:9px;font-size:13px;font-family:inherit;box-sizing:border-box;';
    function svReq(s, f) { return s.contact && s.contact.required && s.contact.required.indexOf(f) !== -1; }
    function surveyHtml(c) {
        var s = c.survey; if (!s || !s.enabled) return '';
        var h = '<div class="ppa-survey" data-cid="' + jsArg(c.id) + '" style="margin-top:14px;border-top:1px solid #eef2f7;padding-top:12px;text-align:left;">';
        if (s.question && s.options && s.options.length) {
            h += '<div style="font-weight:700;font-size:13.5px;margin-bottom:7px;">' + esc(s.question) + '</div><div style="display:flex;flex-direction:column;gap:6px;">';
            s.options.forEach(function (o) { h += '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;"><input type="radio" name="ppasv-' + jsArg(c.id) + '" value="' + esc(o) + '" style="flex:none;"> ' + esc(o) + '</label>'; });
            h += '</div>';
        }
        if (s.rating && s.rating.enabled) {
            var max = s.rating.scale === 10 ? 10 : 5, start = s.rating.scale === 10 ? 0 : 1;
            h += '<div style="margin-top:' + (s.question ? '10px' : '0') + ';">';
            if (s.rating.label) h += '<div style="font-weight:700;font-size:13.5px;margin-bottom:7px;">' + esc(s.rating.label) + '</div>';
            h += '<div style="display:flex;gap:5px;flex-wrap:wrap;">';
            for (var r = start; r <= max; r++) h += '<button type="button" class="ppa-rate" data-v="' + r + '" onclick="ppAnnRate(this)" style="min-width:32px;height:32px;border:1.5px solid #cbd5e1;border-radius:8px;background:#fff;cursor:pointer;font-weight:700;">' + r + '</button>';
            h += '</div></div>';
        }
        var ghlFormOnly = false;
        if (s.contact && s.contact.enabled) {
            if (s.contact.mode === 'ghl_form' && s.contact.ghl_form_id) {
                ghlFormOnly = !(s.question && s.options && s.options.length) && !(s.rating && s.rating.enabled);
                h += '<div style="margin-top:10px;"><iframe src="https://api.leadconnectorhq.com/widget/form/' + esc(s.contact.ghl_form_id) + '" style="width:100%;min-height:460px;border:none;" scrolling="yes"></iframe></div>';
            } else {
                h += '<div style="margin-top:10px;display:flex;flex-direction:column;gap:7px;">';
                if (s.contact.name) h += '<input class="ppa-c-name" placeholder="Your name' + (svReq(s, 'name') ? ' *' : '') + '" style="' + SVINP + '">';
                if (s.contact.email) h += '<input class="ppa-c-email" type="email" placeholder="Email' + (svReq(s, 'email') ? ' *' : '') + '" style="' + SVINP + '">';
                if (s.contact.phone) h += '<input class="ppa-c-phone" placeholder="Phone' + (svReq(s, 'phone') ? ' *' : '') + '" style="' + SVINP + '">';
                h += '</div>';
            }
        }
        if (!ghlFormOnly) {
            h += '<button type="button" class="ppa-cta" style="margin-top:12px;border:none;" onclick="ppAnnSurvey(this)">Submit</button>';
            h += '<div class="ppa-sv-msg" style="font-size:12px;color:#dc2626;margin-top:6px;min-height:14px;"></div>';
        }
        h += '</div>';
        return h;
    }
    window.ppAnnRate = function (btn) {
        var wrap = btn.parentNode;
        Array.prototype.forEach.call(wrap.querySelectorAll('.ppa-rate'), function (b) { b.style.background = '#fff'; b.style.color = '#0a1628'; b.style.borderColor = '#cbd5e1'; });
        btn.style.background = '#004990'; btn.style.color = '#fff'; btn.style.borderColor = '#004990';
        wrap.setAttribute('data-picked', btn.getAttribute('data-v'));
    };
    window.ppAnnSurvey = function (btn) {
        var box = btn.closest ? btn.closest('.ppa-survey') : null; if (!box) return;
        var id = box.getAttribute('data-cid');
        var c = cardList.concat(floatList).filter(function (x) { return jsArg(x.id) === id; })[0]; if (!c) return;
        var s = c.survey || {}; var msg = box.querySelector('.ppa-sv-msg');
        var picked = box.querySelector('input[type=radio]:checked');
        var choice = picked ? picked.value : null;
        var rw = box.querySelector('[data-picked]'); var rating = rw ? rw.getAttribute('data-picked') : null;
        var g = function (cls) { var el = box.querySelector(cls); return el ? el.value.trim() : ''; };
        var name = g('.ppa-c-name'), email = g('.ppa-c-email'), phone = g('.ppa-c-phone');
        if (s.contact && s.contact.enabled) {
            var rq = s.contact.required || [];
            if (rq.indexOf('name') !== -1 && !name) { msg.textContent = 'Please enter your name.'; return; }
            if (rq.indexOf('email') !== -1 && !email) { msg.textContent = 'Please enter your email.'; return; }
            if (rq.indexOf('phone') !== -1 && !phone) { msg.textContent = 'Please enter your phone.'; return; }
            if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = 'Please enter a valid email.'; return; }
        }
        if (!choice && !rating && !name && !email && !phone) { msg.textContent = 'Please answer before submitting.'; return; }
        btn.disabled = true; btn.textContent = 'Submitting…';
        api({ action: 'submit_response', campaign_id: c.id, choice: choice, rating: rating, name: name, email: email, phone: phone, variant: variantMap[c.id] || null }).catch(function () {});
        track(c.id, 'click', 'survey');
        permAdd(c.id); dismissServer(c.id);
        box.innerHTML = '<div style="text-align:center;padding:12px 6px;"><div style="font-size:30px;">✅</div><div style="font-weight:700;font-size:14px;margin-top:6px;">' + esc(s.thanks || 'Thanks for your response!') + '</div></div>';
        setTimeout(function () { removeEverywhere(c.id); }, 1600);
    };

    var REFRESH_MS = 3 * 60 * 1000;    // re-poll get_active so mid-day campaigns appear without a reload
    var started = false;

    // Rebuild the card/float lists from a fresh get_active payload. Snooze state
    // lives in localStorage and dismissed ones are already filtered server-side,
    // so it's safe to rebuild wholesale.
    function applyData(data) {
        var all = (Array.isArray(data) ? data : []).filter(function (c) { return !isPerm(c.id); });
        cardWrap = document.getElementById('staffAnnCarousel') || document.getElementById('annCarousel');
        var newCards = [], newFloat = [];
        all.forEach(function (c) {
            variantMap[c.id] = c.variant || null;
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
