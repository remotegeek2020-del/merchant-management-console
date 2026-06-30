/*
 * Reusable Product Tour engine (Intercom-style).
 * - Auto-runs enabled, unseen tours for the current page (once per staff member per version).
 * - Adds a small floating "Take a tour" button when a tour exists for the page.
 * - Doubles as a visual element PICKER for the Secret Dungeon editor
 *   (opened with ?__tourpick=1 — click any element to capture its CSS selector).
 *
 * Depends on driver.js (loaded via CDN on the page) for the runtime tour UI.
 * Purely additive: if no tour is enabled for a page, this does nothing.
 */
(function () {
    'use strict';

    var PAGE = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    var TOKEN = function () { return localStorage.getItem('pp_session_token') || ''; };
    var qs = new URLSearchParams(location.search);

    // ───────────────────────────────────────────────────────────────────────
    // Unique-selector generation (shared by picker)
    // ───────────────────────────────────────────────────────────────────────
    function cssEscape(s) {
        if (window.CSS && CSS.escape) return CSS.escape(s);
        return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
    }
    function isUnique(sel) {
        try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
    }
    function getUniqueSelector(el) {
        if (!el || el.nodeType !== 1) return '';
        if (el.id) {
            var byId = '#' + cssEscape(el.id);
            if (isUnique(byId)) return byId;
        }
        var parts = [];
        var node = el;
        while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
            var tag = node.tagName.toLowerCase();
            if (node.id) { parts.unshift('#' + cssEscape(node.id)); break; }
            var sel = tag;
            var parent = node.parentNode;
            if (parent) {
                var sameTag = Array.prototype.filter.call(parent.children, function (c) {
                    return c.tagName === node.tagName;
                });
                if (sameTag.length > 1) {
                    var idx = sameTag.indexOf(node) + 1;
                    sel += ':nth-of-type(' + idx + ')';
                }
            }
            parts.unshift(sel);
            var candidate = parts.join(' > ');
            if (isUnique(candidate)) return candidate;
            node = parent;
        }
        return parts.join(' > ');
    }

    // ───────────────────────────────────────────────────────────────────────
    // PICKER MODE — runs when the page is opened with ?__tourpick=1
    // ───────────────────────────────────────────────────────────────────────
    function startPicker() {
        var stepIndex = qs.get('step');
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4338ca;background:rgba(99,102,241,0.18);border-radius:4px;transition:all .05s;display:none;';
        var banner = document.createElement('div');
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#4338ca;color:#fff;font:600 13px system-ui,sans-serif;padding:10px 16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.2);';
        banner.textContent = '🎯 Tour element picker — click the element you want this step to point at.  (Press ESC to cancel)';
        document.body.appendChild(box);
        document.body.appendChild(banner);
        document.documentElement.style.cursor = 'crosshair';

        function ignore(t) { return t === box || t === banner; }
        function onMove(e) {
            var t = e.target;
            if (ignore(t)) { box.style.display = 'none'; return; }
            var r = t.getBoundingClientRect();
            box.style.display = 'block';
            box.style.top = r.top + 'px'; box.style.left = r.left + 'px';
            box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
        }
        function cleanup() {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('keydown', onKey, true);
            box.remove(); banner.remove();
            document.documentElement.style.cursor = '';
        }
        function send(selector) {
            try {
                if (window.opener) window.opener.postMessage({ __tourpick: true, selector: selector, step: stepIndex }, location.origin);
            } catch (e) {}
            cleanup();
            window.close();
            // If close is blocked, show a fallback so the user can copy the selector.
            setTimeout(function () {
                document.body.innerHTML = '<div style="font:600 15px system-ui;padding:40px;text-align:center;color:#1e293b;">Captured selector:<br><code style="display:inline-block;margin-top:12px;padding:8px 12px;background:#f1f5f9;border-radius:8px;">' + (selector || '') + '</code><br><br>You can close this tab.</div>';
            }, 200);
        }
        function onClick(e) {
            if (ignore(e.target)) return;
            e.preventDefault(); e.stopPropagation();
            send(getUniqueSelector(e.target));
        }
        function onKey(e) { if (e.key === 'Escape') { cleanup(); window.close(); } }

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
        document.addEventListener('keydown', onKey, true);
    }

    // ───────────────────────────────────────────────────────────────────────
    // RUNTIME MODE — auto-run enabled tours, add replay button
    // ───────────────────────────────────────────────────────────────────────
    function seenKey(t) { return 'pptour_seen_' + t.tour_key; }
    function hasSeen(t) { return parseInt(localStorage.getItem(seenKey(t)) || '0', 10) >= (t.version || 1); }
    function markSeen(t) { localStorage.setItem(seenKey(t), String(t.version || 1)); }

    function buildSteps(tour) {
        var driverSteps = [];
        (tour.steps || []).forEach(function (s) {
            var pop = { title: s.title || '', description: s.body || '' };
            if (s.position && ['top', 'bottom', 'left', 'right'].indexOf(s.position) >= 0) pop.side = s.position;
            if (s.selector && s.position !== 'over') {
                var el = document.querySelector(s.selector);
                if (!el) return; // element not on page — skip this step gracefully
                driverSteps.push({ element: s.selector, popover: pop });
            } else {
                driverSteps.push({ popover: pop }); // centered card
            }
        });
        return driverSteps;
    }

    function runTour(tour, onDone) {
        var lib = window.driver && window.driver.js && window.driver.js.driver;
        if (!lib) { console.warn('[tour] driver.js not loaded'); if (onDone) onDone(); return; }
        var steps = buildSteps(tour);
        if (!steps.length) { if (onDone) onDone(); return; }
        var d = lib({
            showProgress: true,
            allowClose: true,
            nextBtnText: 'Next',
            prevBtnText: 'Back',
            doneBtnText: 'Done',
            steps: steps,
            onDestroyed: function () { if (onDone) onDone(); }
        });
        d.drive();
    }

    function addReplayButton(tours) {
        if (document.getElementById('pptour-replay')) return;
        var btn = document.createElement('button');
        btn.id = 'pptour-replay';
        btn.title = 'Take a tour of this page';
        btn.innerHTML = '<span style="font-size:16px;">🧭</span> Take a tour';
        btn.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:99990;display:flex;align-items:center;gap:7px;padding:10px 16px;background:#4338ca;color:#fff;border:none;border-radius:999px;font:700 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(67,56,202,.35);';
        btn.onclick = function () {
            if (tours.length === 1) return runTour(tours[0]);
            // Multiple tours: tiny chooser (SweetAlert if available, else prompt)
            if (window.Swal) {
                var inputOptions = {};
                tours.forEach(function (t, i) { inputOptions[i] = t.name; });
                Swal.fire({
                    title: 'Choose a tour', input: 'select', inputOptions: inputOptions,
                    showCancelButton: true, confirmButtonText: 'Start'
                }).then(function (r) { if (r.isConfirmed) runTour(tours[parseInt(r.value, 10)]); });
            } else {
                runTour(tours[0]);
            }
        };
        document.body.appendChild(btn);
    }

    function startRuntime() {
        if (!TOKEN()) return; // not a logged-in staff page
        fetch('/api/product-tours', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN() },
            body: JSON.stringify({ action: 'list_active', page: PAGE })
        }).then(function (r) { return r.json(); }).then(function (data) {
            var tours = (data && data.tours) || [];
            if (!tours.length) return;
            addReplayButton(tours);
            // Auto-run the first unseen tour, then mark it seen.
            var unseen = tours.filter(function (t) { return !hasSeen(t); });
            if (unseen.length) {
                var t = unseen[0];
                // small delay so the page has rendered its widgets
                setTimeout(function () { runTour(t, function () { markSeen(t); }); }, 900);
            }
        }).catch(function () {});
    }

    // ───────────────────────────────────────────────────────────────────────
    function init() {
        if (qs.get('__tourpick') === '1') startPicker();
        else startRuntime();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
