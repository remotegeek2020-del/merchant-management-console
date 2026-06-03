/**
 * PPT Portal — Realm Transition System
 * Special immersive portal for Community and Direct Messages.
 *
 * Entering: full-screen wormhole overlay (~3 s) → navigate
 * Exiting : confirmation dialog → wormhole out → index.html
 */
(function () {
    'use strict';

    const REALMS = {
        'chat':            { name: 'Direct Messages', color: '#0084ff', dark: '#003d99', icon: 'forum' },
        'staff-community': { name: 'Community',       color: '#0d9488', dark: '#065f46', icon: 'groups' }
    };

    // Strip .html extension and leading slash to get a normalised page key
    // Works whether Vercel serves /chat or /chat.html
    const rawPage = window.location.pathname.split('/').pop().replace(/\.html$/i, '') || '';
    const myRealm = REALMS[rawPage] || null;

    // ── INJECT KEYFRAME CSS ────────────────────────────────────────────────────
    // Only keyframes go here — layout/positioning goes as inline styles on elements
    // so they can never be overridden by page CSS.
    const style = document.createElement('style');
    style.textContent = `
        @keyframes rlm-rush {
            0%   { transform: translate(-50%,-50%) scale(5);  opacity: 0;
                   border: 2px solid rgba(0,30,100,0); }
            8%   { opacity: .5; border-color: rgba(0,90,200,.5); }
            50%  { opacity: 1; border-color: rgba(0,161,224,.9);
                   box-shadow: 0 0 14px rgba(0,161,224,.5); }
            82%  { border-color: rgba(160,230,255,1);
                   box-shadow: 0 0 24px rgba(160,230,255,.75); }
            100% { transform: translate(-50%,-50%) scale(0);  opacity: 0;
                   border-color: rgba(255,255,255,1); }
        }
        @keyframes rlm-glow-pulse {
            from { transform: translate(-50%,-50%) scale(1);   opacity: .7; }
            to   { transform: translate(-50%,-50%) scale(1.5); opacity: 1; }
        }
        @keyframes rlm-card-in {
            from { opacity: 0; transform: translateY(20px) scale(.93); filter: blur(4px); }
            to   { opacity: 1; transform: translateY(0)    scale(1);   filter: blur(0); }
        }
        @keyframes rlm-burst-go {
            0%   { opacity: .9; transform: translate(-50%,-50%) scale(1);
                   box-shadow: 0 0 30px 15px rgba(0,161,224,.85); }
            35%  { box-shadow: 0 0 60px 30px rgba(120,210,255,.9); }
            100% { opacity: 1; transform: translate(-50%,-50%) scale(700); }
        }
        @keyframes rlm-dot {
            0%,80%,100% { transform: scale(.7); opacity: .4; }
            40%          { transform: scale(1.1); opacity: 1; }
        }
        @keyframes rlm-label-glow {
            from { text-shadow: 0 0 14px rgba(0,161,224,.7); }
            to   { text-shadow: 0 0 30px rgba(0,161,224,1), 0 0 60px rgba(0,161,224,.5); }
        }
        .rlm-ring {
            position: absolute; top: 50%; left: 50%;
            width: 820px; height: 820px; border-radius: 50%;
            animation: rlm-rush 0.82s linear infinite;
        }
        .rlm-glow-orb {
            position: absolute; top: 50%; left: 50%;
            width: 140px; height: 140px; border-radius: 50%;
            transform: translate(-50%,-50%);
            background: radial-gradient(circle, rgba(0,161,224,.6) 0%, transparent 70%);
            animation: rlm-glow-pulse 1.6s ease-in-out infinite alternate;
            pointer-events: none;
        }
        .rlm-burst-dot {
            position: absolute; top: 50%; left: 50%;
            width: 8px; height: 8px; border-radius: 50%;
            background: white; transform: translate(-50%,-50%);
            opacity: 0; pointer-events: none;
        }
        .rlm-burst-dot.go { animation: rlm-burst-go .65s ease-in forwards; }
        .rlm-card {
            position: relative; z-index: 10;
            display: flex; flex-direction: column; align-items: center; gap: 14px;
            opacity: 0;
            animation: rlm-card-in .65s ease-out 1s both;
        }
        .rlm-icon-wrap {
            width: 68px; height: 68px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            color: white; font-size: 30px;
        }
        .rlm-title {
            font-family: 'DM Sans', sans-serif;
            font-size: 24px; font-weight: 800; color: white; letter-spacing: .3px;
            animation: rlm-label-glow 1.4s ease-in-out infinite alternate;
        }
        .rlm-subtitle {
            font-family: 'DM Sans', sans-serif;
            font-size: 12px; font-weight: 600; color: rgba(160,220,255,.75);
            letter-spacing: 2px; text-transform: uppercase;
        }
        .rlm-dots { display: flex; gap: 8px; }
        .rlm-dots span {
            width: 8px; height: 8px; border-radius: 50%;
            background: rgba(0,161,224,.9);
            animation: rlm-dot 1.2s ease-in-out infinite;
        }
        .rlm-dots span:nth-child(2) { animation-delay: .2s; }
        .rlm-dots span:nth-child(3) { animation-delay: .4s; }

        /* ── EXIT CONFIRM DIALOG ── */
        #realm-confirm {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            z-index: 2147483646;
            background: rgba(0,8,20,.75);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            display: none; align-items: center; justify-content: center;
        }
        #realm-confirm.show { display: flex; }
        .rlm-dialog {
            background: #0a1628;
            border: 1px solid rgba(0,161,224,.3);
            border-radius: 22px; padding: 38px 42px; max-width: 380px; width: 90%;
            text-align: center;
            box-shadow: 0 0 80px rgba(0,80,200,.35), inset 0 1px 0 rgba(255,255,255,.06);
        }
        .rlm-dialog-icon {
            width: 58px; height: 58px; border-radius: 50%; margin: 0 auto 18px;
            display: flex; align-items: center; justify-content: center;
            color: white; font-size: 26px;
        }
        .rlm-dialog h2 {
            font-family: 'DM Sans', sans-serif;
            font-size: 21px; font-weight: 800; color: white; margin: 0 0 10px;
        }
        .rlm-dialog p {
            font-family: 'DM Sans', sans-serif;
            font-size: 13px; color: rgba(150,205,255,.7); margin: 0 0 28px; line-height: 1.6;
        }
        .rlm-dialog-btns { display: flex; gap: 10px; }
        .rlm-btn-stay {
            flex: 1; padding: 12px; border-radius: 11px; font-size: 13px; font-weight: 700;
            font-family: 'DM Sans', sans-serif; cursor: pointer;
            background: rgba(255,255,255,.07);
            border: 1px solid rgba(255,255,255,.14);
            color: rgba(255,255,255,.85); transition: background .2s;
        }
        .rlm-btn-stay:hover { background: rgba(255,255,255,.14); }
        .rlm-btn-exit {
            flex: 1; padding: 12px; border-radius: 11px; font-size: 13px; font-weight: 700;
            font-family: 'DM Sans', sans-serif; cursor: pointer;
            background: linear-gradient(135deg, #0068d9 0%, #003a8c 100%);
            border: 1px solid rgba(0,161,224,.4);
            color: white; transition: opacity .2s;
        }
        .rlm-btn-exit:hover { opacity: .85; }
    `;
    document.head.appendChild(style);

    // ── HELPERS ────────────────────────────────────────────────────────────────
    // Inline style string for the full-screen overlay — immune to page CSS overrides
    const OVERLAY_STYLE = [
        'position:fixed', 'top:0', 'left:0', 'right:0', 'bottom:0',
        'width:100vw', 'height:100vh',
        'z-index:2147483647',
        'background:radial-gradient(ellipse 80% 70% at 50% 48%, #001e45 0%, #000c22 55%, #000408 100%)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'overflow:hidden'
    ].join(';');

    function makeRings(n) {
        let h = '';
        for (let i = 0; i < n; i++) {
            h += `<div class="rlm-ring" style="animation-delay:${(i * -0.068).toFixed(3)}s"></div>`;
        }
        return h;
    }

    // ── ENTER PORTAL ───────────────────────────────────────────────────────────
    let _enterBusy = false;

    function enterRealm(href, realm) {
        if (_enterBusy) return;
        _enterBusy = true;

        const el = document.createElement('div');
        el.id = 'realm-enter';
        el.setAttribute('style', OVERLAY_STYLE);
        el.innerHTML = `
            ${makeRings(12)}
            <div class="rlm-glow-orb"></div>
            <div class="rlm-burst-dot" id="rlm-burst"></div>
            <div class="rlm-card">
                <div class="rlm-icon-wrap" style="background:linear-gradient(135deg,${realm.color},${realm.dark});box-shadow:0 0 36px 8px ${realm.color}88;">
                    <span class="material-icons">${realm.icon}</span>
                </div>
                <div class="rlm-title">${realm.name}</div>
                <div class="rlm-subtitle">Opening portal&hellip;</div>
                <div class="rlm-dots"><span></span><span></span><span></span></div>
            </div>
        `;
        document.body.appendChild(el);

        setTimeout(() => {
            const burst = el.querySelector('#rlm-burst');
            if (burst) burst.classList.add('go');
        }, 2600);

        setTimeout(() => {
            sessionStorage.setItem('pnt_navigating', '1');
            window.location.href = href;
        }, 3150);
    }

    // ── EXIT PORTAL ────────────────────────────────────────────────────────────
    let _exitBusy = false;

    function doExit() {
        if (_exitBusy) return;
        _exitBusy = true;

        const el = document.createElement('div');
        el.id = 'realm-exit';
        el.setAttribute('style', OVERLAY_STYLE);
        el.innerHTML = `${makeRings(12)}<div class="rlm-glow-orb"></div><div class="rlm-burst-dot" id="rlm-exit-burst"></div>`;
        document.body.appendChild(el);

        setTimeout(() => {
            const burst = document.getElementById('rlm-exit-burst');
            if (burst) burst.classList.add('go');
        }, 1000);

        setTimeout(() => {
            sessionStorage.setItem('pnt_navigating', '1');
            window.location.href = '/';
        }, 1550);
    }

    function showExitConfirm() {
        let confirm = document.getElementById('realm-confirm');
        if (!confirm) {
            confirm = document.createElement('div');
            confirm.id = 'realm-confirm';
            confirm.innerHTML = `
                <div class="rlm-dialog">
                    <div class="rlm-dialog-icon" style="background:linear-gradient(135deg,${myRealm.color},${myRealm.dark});">
                        <span class="material-icons">${myRealm.icon}</span>
                    </div>
                    <h2>Leaving ${myRealm.name}?</h2>
                    <p>You're about to step back through the portal to the main console.</p>
                    <div class="rlm-dialog-btns">
                        <button class="rlm-btn-stay" id="rlm-stay">Stay Here</button>
                        <button class="rlm-btn-exit" id="rlm-exit-btn">Exit Portal</button>
                    </div>
                </div>
            `;
            document.body.appendChild(confirm);

            document.getElementById('rlm-stay').addEventListener('click', () => {
                confirm.classList.remove('show');
            });
            document.getElementById('rlm-exit-btn').addEventListener('click', () => {
                confirm.classList.remove('show');
                doExit();
            });
        }
        confirm.classList.add('show');
    }

    // ── WIRE UP ENTRY (on non-realm pages like index.html) ─────────────────────
    if (!myRealm) {
        document.addEventListener('click', function (e) {
            const link = e.target.closest('a[href]');
            if (!link) return;
            const href = link.getAttribute('href');

            // Match chat.html / chat  and staff-community.html / staff-community
            const realmKey = Object.keys(REALMS).find(k =>
                href === k ||
                href === k + '.html' ||
                href.endsWith('/' + k) ||
                href.endsWith('/' + k + '.html')
            );
            if (!realmKey) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            enterRealm(href, REALMS[realmKey]);
        }, true);
    }

    // ── WIRE UP EXIT (on chat / staff-community pages) ─────────────────────────
    if (myRealm) {
        document.addEventListener('click', function (e) {
            // Link-based home/back buttons
            const link = e.target.closest('a[href]');
            if (link) {
                const href = link.getAttribute('href');
                if (href === '/' || href === 'index.html' || href === '../index.html' || href === './index.html') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    showExitConfirm();
                    return;
                }
            }

            // Button-based home icon (chat.html header home button)
            const btn = e.target.closest('button[title="Home"]');
            if (btn) {
                e.preventDefault();
                e.stopImmediatePropagation();
                showExitConfirm();
            }
        }, true);

        // Neutralise the inline onclick on the home icon button so it can't race
        document.addEventListener('DOMContentLoaded', function () {
            document.querySelectorAll('button[title="Home"]').forEach(btn => {
                btn.removeAttribute('onclick');
            });
        });
    }

    // ── BFCACHE CLEANUP ────────────────────────────────────────────────────────
    // When the browser restores a page from the back-forward cache it freezes
    // the DOM as-is, including any overlay that was mid-animation. Clean it up
    // on pageshow so the user isn't stuck looking at a portal overlay.
    window.addEventListener('pageshow', function (e) {
        if (!e.persisted) return;
        ['realm-enter', 'realm-exit', 'realm-confirm'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });
        _enterBusy = false;
        _exitBusy  = false;
    });
})();
