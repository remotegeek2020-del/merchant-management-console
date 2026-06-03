/**
 * PPT Portal — Realm Transition System
 * Special immersive portal for Community and Direct Messages.
 *
 * Entering: full-screen wormhole overlay (3 s) → navigate
 * Exiting : confirmation dialog → wormhole out → index.html
 */
(function () {
    'use strict';

    const REALMS = {
        'chat.html':            { name: 'Direct Messages', color: '#0084ff', dark: '#003d99', icon: 'forum' },
        'staff-community.html': { name: 'Community',       color: '#0d9488', dark: '#065f46', icon: 'groups' }
    };

    const page   = window.location.pathname.split('/').pop() || '';
    const myRealm = REALMS[page] || null;

    // ── INJECT CSS ─────────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        /* ── ENTER OVERLAY ── */
        #realm-enter {
            position: fixed; inset: 0; z-index: 2147483647;
            background: radial-gradient(ellipse 80% 70% at 50% 48%,
                #001e45 0%, #000c22 55%, #000408 100%);
            display: flex; align-items: center; justify-content: center;
            overflow: hidden;
        }

        /* Wormhole rings */
        .rlm-ring {
            position: absolute; top: 50%; left: 50%;
            width: 800px; height: 800px; border-radius: 50%;
            animation: rlm-rush 0.80s linear infinite;
        }
        @keyframes rlm-rush {
            0%   { transform: translate(-50%,-50%) scale(5);  opacity: 0; border: 2px solid rgba(0,30,100,0); }
            8%   { opacity: .5; border-color: rgba(0,90,200,.5); }
            50%  { opacity: 1; border-color: rgba(0,161,224,.9); box-shadow: 0 0 14px rgba(0,161,224,.5); }
            82%  { border-color: rgba(160,230,255,1); box-shadow: 0 0 24px rgba(160,230,255,.75); }
            100% { transform: translate(-50%,-50%) scale(0);  opacity: 0; border-color: rgba(255,255,255,1); }
        }

        /* Centre glow */
        .rlm-glow {
            position: absolute; top: 50%; left: 50%;
            width: 120px; height: 120px; border-radius: 50%;
            transform: translate(-50%,-50%);
            background: radial-gradient(circle, rgba(0,161,224,.55) 0%, transparent 70%);
            animation: rlm-glow-pulse 1.6s ease-in-out infinite alternate;
        }
        @keyframes rlm-glow-pulse {
            from { transform: translate(-50%,-50%) scale(1);   opacity: .7; }
            to   { transform: translate(-50%,-50%) scale(1.4); opacity: 1; }
        }

        /* Message card */
        #realm-enter-card {
            position: relative; z-index: 10;
            display: flex; flex-direction: column; align-items: center; gap: 14px;
            opacity: 0;
            animation: rlm-card-in .6s ease-out 1s both;
        }
        @keyframes rlm-card-in {
            from { opacity: 0; transform: translateY(18px) scale(.94); }
            to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        #realm-enter-card .rlm-icon {
            width: 64px; height: 64px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            font-size: 30px; color: white;
            box-shadow: 0 0 32px 8px var(--rlm-color, rgba(0,161,224,.7));
        }
        #realm-enter-card .rlm-label {
            font-family: 'DM Sans', sans-serif;
            font-size: 22px; font-weight: 800; color: white; letter-spacing: .5px;
            text-shadow: 0 0 20px rgba(0,161,224,.9);
        }
        #realm-enter-card .rlm-sub {
            font-family: 'DM Sans', sans-serif;
            font-size: 13px; font-weight: 500; color: rgba(160,220,255,.75);
            letter-spacing: 1.5px; text-transform: uppercase;
        }
        /* Dot loader */
        .rlm-dots { display: flex; gap: 7px; margin-top: 4px; }
        .rlm-dots span {
            width: 7px; height: 7px; border-radius: 50%;
            background: rgba(0,161,224,.9);
            animation: rlm-dot 1.2s ease-in-out infinite;
        }
        .rlm-dots span:nth-child(2) { animation-delay: .2s; }
        .rlm-dots span:nth-child(3) { animation-delay: .4s; }
        @keyframes rlm-dot {
            0%,80%,100% { transform: scale(.7); opacity: .4; }
            40%          { transform: scale(1);  opacity: 1;  }
        }

        /* End-burst light */
        .rlm-burst {
            position: absolute; top: 50%; left: 50%;
            width: 6px; height: 6px; border-radius: 50%; background: white;
            transform: translate(-50%,-50%); opacity: 0; pointer-events: none;
        }
        .rlm-burst.go {
            animation: rlm-burst-go .7s ease-in forwards;
        }
        @keyframes rlm-burst-go {
            0%   { opacity: .9; transform: translate(-50%,-50%) scale(1);
                   box-shadow: 0 0 30px 15px rgba(0,161,224,.85); }
            35%  { box-shadow: 0 0 60px 30px rgba(120,210,255,.9); }
            100% { opacity: 1; transform: translate(-50%,-50%) scale(700); }
        }

        /* ── EXIT OVERLAY ── */
        #realm-exit {
            position: fixed; inset: 0; z-index: 2147483647;
            background: radial-gradient(ellipse 80% 70% at 50% 48%,
                #001e45 0%, #000c22 55%, #000408 100%);
            display: none; align-items: center; justify-content: center;
            overflow: hidden;
        }
        #realm-exit.show { display: flex; }

        /* ── CONFIRM DIALOG ── */
        #realm-confirm {
            position: fixed; inset: 0; z-index: 2147483646;
            background: rgba(0,0,0,.65); backdrop-filter: blur(6px);
            display: none; align-items: center; justify-content: center;
        }
        #realm-confirm.show { display: flex; }
        .rlm-dialog {
            background: #0d1b2e; border: 1px solid rgba(0,161,224,.35);
            border-radius: 20px; padding: 36px 40px; max-width: 380px; width: 90%;
            text-align: center; box-shadow: 0 0 60px rgba(0,100,200,.3);
        }
        .rlm-dialog-icon {
            width: 56px; height: 56px; border-radius: 50%; margin: 0 auto 18px;
            display: flex; align-items: center; justify-content: center;
            font-size: 26px; color: white;
        }
        .rlm-dialog h2 {
            font-family: 'DM Sans', sans-serif;
            font-size: 20px; font-weight: 800; color: white; margin: 0 0 10px;
        }
        .rlm-dialog p {
            font-family: 'DM Sans', sans-serif;
            font-size: 13px; color: rgba(160,210,255,.75); margin: 0 0 28px; line-height: 1.55;
        }
        .rlm-dialog-btns { display: flex; gap: 10px; }
        .rlm-btn-stay {
            flex: 1; padding: 11px; border-radius: 10px; font-size: 13px; font-weight: 700;
            font-family: 'DM Sans', sans-serif; cursor: pointer;
            background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.15); color: white;
            transition: background .2s;
        }
        .rlm-btn-stay:hover { background: rgba(255,255,255,.15); }
        .rlm-btn-exit {
            flex: 1; padding: 11px; border-radius: 10px; font-size: 13px; font-weight: 700;
            font-family: 'DM Sans', sans-serif; cursor: pointer;
            background: linear-gradient(135deg, #0068d9, #003a8c);
            border: 1px solid rgba(0,161,224,.4); color: white; transition: opacity .2s;
        }
        .rlm-btn-exit:hover { opacity: .85; }
    `;
    document.head.appendChild(style);

    // ── HELPERS ────────────────────────────────────────────────────────────────
    function makeRings(n) {
        let h = '';
        for (let i = 0; i < n; i++) {
            h += `<div class="rlm-ring" style="animation-delay:${(i * -0.067).toFixed(3)}s"></div>`;
        }
        return h;
    }

    // ── ENTER PORTAL (called from index.html when clicking community/chat card) ─
    let _enterBusy = false;

    function enterRealm(href, realm) {
        if (_enterBusy) return;
        _enterBusy = true;

        const color  = realm.color;
        const dark   = realm.dark;
        const el = document.createElement('div');
        el.id = 'realm-enter';
        el.innerHTML = `
            ${makeRings(12)}
            <div class="rlm-glow"></div>
            <div class="rlm-burst" id="rlm-burst"></div>
            <div id="realm-enter-card" style="--rlm-color:${color}88;">
                <div class="rlm-icon" style="background:linear-gradient(135deg,${color},${dark});">
                    <span class="material-icons">${realm.icon}</span>
                </div>
                <div class="rlm-label">Entering ${realm.name}</div>
                <div class="rlm-sub">Opening portal&hellip;</div>
                <div class="rlm-dots"><span></span><span></span><span></span></div>
            </div>
        `;
        document.body.appendChild(el);

        // Burst + navigate
        setTimeout(() => {
            const burst = el.querySelector('#rlm-burst');
            if (burst) burst.classList.add('go');
        }, 2600);

        setTimeout(() => {
            sessionStorage.setItem('pnt_navigating', '1');
            window.location.href = href;
        }, 3100);
    }

    // ── EXIT PORTAL (called from chat.html / staff-community.html) ─────────────
    function buildExitOverlay() {
        if (document.getElementById('realm-exit')) return;
        const el = document.createElement('div');
        el.id = 'realm-exit';
        el.innerHTML = `${makeRings(12)}<div class="rlm-glow"></div><div class="rlm-burst" id="rlm-exit-burst"></div>`;
        document.body.appendChild(el);
    }

    function doExit() {
        buildExitOverlay();
        const el = document.getElementById('realm-exit');
        el.classList.add('show');

        setTimeout(() => {
            const burst = document.getElementById('rlm-exit-burst');
            if (burst) burst.classList.add('go');
        }, 1000);

        setTimeout(() => {
            sessionStorage.setItem('pnt_navigating', '1');
            window.location.href = '/';
        }, 1500);
    }

    function showExitConfirm() {
        buildExitOverlay();

        let confirm = document.getElementById('realm-confirm');
        if (!confirm) {
            confirm = document.createElement('div');
            confirm.id = 'realm-confirm';
            const realm = myRealm;
            confirm.innerHTML = `
                <div class="rlm-dialog">
                    <div class="rlm-dialog-icon" style="background:linear-gradient(135deg,${realm.color},${realm.dark});">
                        <span class="material-icons">${realm.icon}</span>
                    </div>
                    <h2>Leaving ${realm.name}?</h2>
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

    // ── WIRE UP ENTRY (index.html side) ────────────────────────────────────────
    if (!myRealm) {
        document.addEventListener('click', function (e) {
            const link = e.target.closest('a[href]');
            if (!link) return;
            const href = link.getAttribute('href');
            const realmKey = Object.keys(REALMS).find(k => href === k || href.endsWith('/' + k));
            if (!realmKey) return;

            e.preventDefault();
            e.stopImmediatePropagation(); // prevent portal-transition.js from firing
            enterRealm(href, REALMS[realmKey]);
        }, true);
    }

    // ── WIRE UP EXIT (chat / community side) ───────────────────────────────────
    if (myRealm) {
        // Intercept link-based home/back buttons
        document.addEventListener('click', function (e) {
            const link = e.target.closest('a[href]');
            if (link) {
                const href = link.getAttribute('href');
                if (href === '/' || href === 'index.html' || href === '../index.html') {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    showExitConfirm();
                    return;
                }
            }

            // Intercept inline onclick home buttons (e.g. chat.html's icon button)
            const btn = e.target.closest('button[title="Home"]');
            if (btn) {
                e.preventDefault();
                e.stopImmediatePropagation();
                showExitConfirm();
            }
        }, true);

        // Also neutralise the inline onclick so it doesn't race
        document.addEventListener('DOMContentLoaded', function () {
            document.querySelectorAll('button[title="Home"]').forEach(btn => {
                btn.setAttribute('onclick', '');
            });
        });
    }
})();
