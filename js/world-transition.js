// "Entering a different world" transition for the partner side.
//
// The partner experience has THREE worlds:
//   • portal  — the PayProTec Portal (dashboard, merchants, residuals, …)
//   • agency  — the branded Agency (home launchpad, agency home, settings)
//   • crm     — a CRM sub-account workspace
//
// When you cross from one world to another we play a full-screen portal flash
// (like the staff login's wormhole exit) showing the destination world, then
// navigate. Same-world navigation is left alone (handled by pp-transition.js's
// View Transition crossfade). No per-link wiring: we classify the destination
// URL and only flash when the world actually changes.
(function () {
    'use strict';

    var WORLDS = {
        portal: { name: 'PayProTec Portal', sub: 'Your partner account', icon: 'dashboard' },
        agency: { name: 'Agency', sub: 'Your white-label office', icon: 'apartment' },
        crm: { name: 'CRM Workspace', sub: 'Sub-account', icon: 'hub' }
    };

    function worldOf(path) {
        path = (path || location.pathname).split('?')[0];
        if (/^\/partner\/(home|agency|agency-settings)(\/|$)/.test(path)) return 'agency';
        if (/^\/partner\/(sub-account|sub-account-settings)(\/|$)/.test(path)) return 'crm';
        if (/^\/partner(\/|$)/.test(path)) return 'portal';
        return null; // not a partner page → don't touch
    }

    // ── CSS ──────────────────────────────────────────────────────────────────
    var style = document.createElement('style');
    style.textContent =
        '#ppw-ov,#ppw-entry{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;'
        + 'background:radial-gradient(circle at 50% 42%, var(--ppw-accent,#0d9488) 0%, var(--ppw-navy,#001e3c) 46%, #00111d 100%);}'
        + '#ppw-ov{z-index:2147483640;pointer-events:none;opacity:0;transition:opacity .32s ease;}'
        + '#ppw-ov.on{opacity:1;pointer-events:all;}'
        + '#ppw-entry{z-index:2147483639;pointer-events:none;animation:ppw-reveal .5s ease-out .03s both;}'
        + '@keyframes ppw-reveal{from{opacity:1;}to{opacity:0;visibility:hidden;}}'
        + '.ppw-badge{width:76px;height:76px;border-radius:22px;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;color:#fff;animation:ppw-pulse 1.1s ease-in-out infinite;}'
        + '.ppw-badge .material-icons{font-size:40px;}'
        + '.ppw-name{color:#fff;font-weight:800;font-size:19px;letter-spacing:.3px;font-family:"DM Sans",sans-serif;}'
        + '.ppw-sub{color:rgba(255,255,255,.6);font-size:12px;font-weight:600;font-family:"DM Sans",sans-serif;}'
        + '@keyframes ppw-pulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(255,255,255,.28);}50%{transform:scale(1.09);box-shadow:0 0 0 18px rgba(255,255,255,0);}}'
        + '@media (prefers-reduced-motion: reduce){.ppw-badge{animation:none;}#ppw-ov,#ppw-entry{transition:none;animation:none;}}';
    (document.head || document.documentElement).appendChild(style);

    // Pull the current theme's colors so the flash matches the world you're in
    // (PayProTec navy on the portal, the agency's brand color in agency/CRM).
    function paint(el) {
        try {
            var cs = getComputedStyle(document.documentElement);
            var accent = (cs.getPropertyValue('--teal') || '#0d9488').trim();
            var navy = (cs.getPropertyValue('--navy') || '#001e3c').trim();
            el.style.setProperty('--ppw-accent', accent);
            el.style.setProperty('--ppw-navy', navy);
        } catch (e) {}
    }

    var _busy = false;
    function enter(url, world) {
        if (_busy) return; _busy = true;
        if (typeof Swal !== 'undefined') { try { Swal.close(); } catch (e) {} }
        var w = WORLDS[world] || WORLDS.portal;
        var ov = document.createElement('div');
        ov.id = 'ppw-ov';
        ov.innerHTML = '<div class="ppw-badge"><span class="material-icons">' + w.icon + '</span></div>'
            + '<div class="ppw-name">' + w.name + '</div><div class="ppw-sub">Entering…</div>';
        paint(ov);
        document.body.appendChild(ov);
        requestAnimationFrame(function () { ov.classList.add('on'); });
        try { sessionStorage.setItem('ppw_enter', world); } catch (e) {}
        setTimeout(function () { window.location.href = url; }, 540);
    }

    // Public: JS-driven navigations (buttons, enterAgency, etc.) call this.
    window.ppWorldGo = function (url) {
        var w = worldOf(url);
        if (!w || w === worldOf(location.pathname)) { window.location.href = url; return; }
        enter(url, w);
    };

    // ── CLICK INTERCEPTOR (anchors only; same-world falls through) ─────────────
    document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        var href = a.getAttribute('href');
        if (!href || /^(https?:|\/\/|#|javascript:|mailto:|tel:)/i.test(href) || href.indexOf('/api/') === 0
            || a.target === '_blank' || a.hasAttribute('download')) return;
        var dest = worldOf(href);
        if (!dest || dest === worldOf(location.pathname)) return; // same world → normal nav / VT
        e.preventDefault(); e.stopPropagation();
        enter(href, dest);
    }, true);

    // ── ENTRY REVEAL ──────────────────────────────────────────────────────────
    // Runs immediately (works from <head>) so the panel covers the incoming page
    // before its content paints, then fades to reveal the new world.
    (function reveal() {
        var w;
        try { w = sessionStorage.getItem('ppw_enter'); sessionStorage.removeItem('ppw_enter'); } catch (e) {}
        if (!w) return;
        var el = document.createElement('div');
        el.id = 'ppw-entry';
        paint(el);
        (document.body || document.documentElement).appendChild(el);
        el.addEventListener('animationend', function () { el.remove(); }, { once: true });
    })();

    // bfcache: clear any leftover overlay when returning via back/forward
    window.addEventListener('pageshow', function (e) {
        if (!e.persisted) return;
        ['ppw-ov', 'ppw-entry'].forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
        _busy = false;
    });
})();
