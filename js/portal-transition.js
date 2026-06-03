/**
 * PPT Portal — Page Transition System
 * Outgoing: wormhole rings → expanding white light → navigate
 * Incoming: white flash fades out to reveal the new page
 */
(function () {
    'use strict';

    // ── INJECT CSS ───────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        /* Wormhole exit overlay */
        #pnt-overlay {
            position: fixed; inset: 0; z-index: 2147483640;
            pointer-events: none; opacity: 0;
            background: radial-gradient(ellipse 80% 70% at 50% 48%,
                #001e45 0%, #000c22 55%, #000408 100%);
        }
        #pnt-overlay.pnt-active { pointer-events: all; opacity: 1; }

        .pnt-ring {
            position: absolute; top: 50%; left: 50%;
            width: 700px; height: 700px;
            border-radius: 50%;
            animation: pnt-rush 0.72s linear infinite;
        }
        @keyframes pnt-rush {
            0%   { transform:translate(-50%,-50%) scale(5);   opacity:0; border:2px solid rgba(0,30,100,0); }
            8%   { opacity:.5;  border-color:rgba(0,90,200,.5); }
            50%  { opacity:1;   border-color:rgba(0,161,224,.9); box-shadow:0 0 12px rgba(0,161,224,.45); }
            82%  { border-color:rgba(160,230,255,1); box-shadow:0 0 22px rgba(160,230,255,.7); }
            100% { transform:translate(-50%,-50%) scale(0);   opacity:0; border-color:rgba(255,255,255,1); }
        }

        .pnt-light {
            position: absolute; top: 50%; left: 50%;
            width: 6px; height: 6px; border-radius: 50%;
            background: white; opacity: 0;
            pointer-events: none; transform: translate(-50%,-50%);
        }
        .pnt-light.pnt-go {
            animation: pnt-light-expand 0.95s ease-in forwards;
        }
        @keyframes pnt-light-expand {
            0%   { opacity:.9; transform:translate(-50%,-50%) scale(1);
                   box-shadow:0 0 30px 15px rgba(0,161,224,.85); }
            35%  { box-shadow:0 0 60px 30px rgba(120,210,255,.9); }
            70%  { box-shadow:0 0 80px 40px rgba(220,245,255,1); }
            100% { opacity:1; transform:translate(-50%,-50%) scale(650); }
        }

        /* Entry flash: white screen that fades out to reveal the page */
        #pnt-entry {
            position: fixed; inset: 0; z-index: 2147483639;
            background: white; pointer-events: none;
            animation: pnt-entry-out 0.55s ease-out 0.05s both;
        }
        @keyframes pnt-entry-out {
            from { opacity: 1; }
            to   { opacity: 0; }
        }
    `;
    document.head.appendChild(style);

    // ── BUILD OVERLAY (lazy, once) ───────────────────────────────────────────
    function getOverlay() {
        let overlay = document.getElementById('pnt-overlay');
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.id = 'pnt-overlay';
        let html = '';
        for (let i = 0; i < 12; i++) {
            html += `<div class="pnt-ring" style="animation-delay:${(i * -0.06).toFixed(2)}s"></div>`;
        }
        html += '<div class="pnt-light"></div>';
        overlay.innerHTML = html;
        document.body.appendChild(overlay);
        return overlay;
    }

    // ── ENTRY FLASH ──────────────────────────────────────────────────────────
    function addEntryFlash() {
        // Login page manages its own entrance animation — skip
        if (document.getElementById('login-ui')) return;
        // Only play if we look like we arrived via a portal navigate
        // (stored flag set on exit)
        if (!sessionStorage.getItem('pnt_navigating')) return;
        sessionStorage.removeItem('pnt_navigating');

        const el = document.createElement('div');
        el.id = 'pnt-entry';
        document.body.appendChild(el);
        el.addEventListener('animationend', () => el.remove(), { once: true });
    }

    // ── WORMHOLE NAVIGATE ────────────────────────────────────────────────────
    let _busy = false;

    function portalNavigate(url) {
        if (_busy) return;
        _busy = true;

        // Close any Swal dialog
        if (typeof Swal !== 'undefined') Swal.close();

        const overlay = getOverlay();
        const light   = overlay.querySelector('.pnt-light');

        // Fade in overlay instantly (CSS handles it via .pnt-active opacity:1)
        overlay.style.transition = 'opacity 0.12s ease';
        overlay.classList.add('pnt-active');

        // Trigger the light burst halfway through
        setTimeout(() => {
            if (light) light.classList.add('pnt-go');
        }, 620);

        // Navigate once white fills the screen
        setTimeout(() => {
            sessionStorage.setItem('pnt_navigating', '1');
            window.location.href = url;
        }, 1380);
    }

    // ── CLICK INTERCEPTOR ────────────────────────────────────────────────────
    document.addEventListener('click', function (e) {
        const link = e.target.closest('a[href]');
        if (!link) return;

        const href = link.getAttribute('href');
        if (!href) return;

        // Skip: external, anchors, special schemes, new-tab, downloads
        if (href.startsWith('http') || href.startsWith('//') ||
            href.startsWith('#')    || href.startsWith('javascript') ||
            href.startsWith('mailto') || href.startsWith('tel') ||
            href.startsWith('/api/') ||
            link.target === '_blank' ||
            link.hasAttribute('download')) return;

        // On index.html: only intercept links inside #page-curtain (logged-in state)
        // On all other pages: intercept everything internal
        const curtain = document.getElementById('page-curtain');
        if (curtain && !curtain.contains(link)) return;

        e.preventDefault();
        e.stopPropagation();
        portalNavigate(href);
    }, true);

    // ── INIT ─────────────────────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', addEntryFlash);
    } else {
        addEntryFlash();
    }
})();
