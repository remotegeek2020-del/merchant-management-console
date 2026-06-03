/**
 * PPT Portal — Page Transition System
 * Outgoing: quick blue-white flash out → navigate
 * Incoming: white flash fades to reveal the new page
 */
(function () {
    'use strict';

    // ── INJECT CSS ───────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        /* Exit flash overlay */
        #pnt-overlay {
            position: fixed; inset: 0; z-index: 2147483640;
            pointer-events: none; opacity: 0;
            background: white;
            transition: opacity 0.22s ease-out;
        }
        #pnt-overlay.pnt-active {
            pointer-events: all;
            opacity: 1;
        }

        /* Entry flash: white screen that fades out to reveal the page */
        #pnt-entry {
            position: fixed; inset: 0; z-index: 2147483639;
            background: white; pointer-events: none;
            animation: pnt-entry-out 0.32s ease-out 0.02s both;
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
        document.body.appendChild(overlay);
        return overlay;
    }

    // ── ENTRY FLASH ──────────────────────────────────────────────────────────
    function addEntryFlash() {
        // Login page manages its own entrance animation — skip
        if (document.getElementById('login-ui')) return;
        // Only play if we arrived via a portal navigate
        if (!sessionStorage.getItem('pnt_navigating')) return;
        sessionStorage.removeItem('pnt_navigating');

        const el = document.createElement('div');
        el.id = 'pnt-entry';
        document.body.appendChild(el);
        el.addEventListener('animationend', () => el.remove(), { once: true });
    }

    // ── FLASH NAVIGATE ────────────────────────────────────────────────────────
    let _busy = false;

    function portalNavigate(url) {
        if (_busy) return;
        _busy = true;

        if (typeof Swal !== 'undefined') Swal.close();

        const overlay = getOverlay();
        // Fade in the white overlay
        overlay.classList.add('pnt-active');

        // Navigate once the fade is complete
        setTimeout(() => {
            sessionStorage.setItem('pnt_navigating', '1');
            window.location.href = url;
        }, 260);
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

    // ── BFCACHE CLEANUP ───────────────────────────────────────────────────────
    window.addEventListener('pageshow', function (e) {
        if (!e.persisted) return;
        ['pnt-overlay', 'pnt-entry'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });
        _busy = false;
    });
})();
