// Auto-attach session token to all /api/ calls and handle 401 session expiry globally
(function () {
    const EXEMPT = ['/api/login', '/api/partner-auth', '/api/setup-password', '/api/partner-data'];
    const _fetch = window.fetch.bind(window);
    window.fetch = function (url, opts) {
        opts = opts ? Object.assign({}, opts) : {};
        const urlStr = typeof url === 'string' ? url : (url?.url || '');
        const needsToken = urlStr.startsWith('/api/') && !EXEMPT.some(e => urlStr.startsWith(e));
        let sentStaffToken = false;
        if (needsToken) {
            const token = localStorage.getItem('pp_session_token');
            if (token) {
                opts.headers = Object.assign({}, opts.headers, { 'Authorization': 'Bearer ' + token });
                sentStaffToken = true;
            }
        }
        return _fetch(url, opts).then(async function (res) {
            // Only treat 401 as session expiry if we actually sent a staff token.
            // Partner portal pages call staff APIs without a staff token — a 401
            // in that case means "not a staff user", not "session expired".
            if (res.status === 401 && sentStaffToken) {
                let data = {};
                try { data = await res.clone().json(); } catch (e) {}
                if (data.reason === 'session_expired' || data.reason === 'no_token' || data.reason === 'invalid_token') {
                    const devTok = localStorage.getItem('pp_device_token');
                    localStorage.clear();
                    if (devTok) localStorage.setItem('pp_device_token', devTok);
                    const isLogin = window.location.pathname === '/' || window.location.pathname.endsWith('/index.html') || window.location.pathname === '';
                    if (!isLogin) window.location.href = '/index.html?reason=session_expired';
                    // Throw so downstream page code never processes the 401 response
                    throw new Error('Session expired. Redirecting to login.');
                }
            }
            return res;
        });
    };
})();

(async function () {
    'use strict';
    const CACHE_KEY = 'pp_sc';
    const TTL = 2 * 60 * 1000; // 2 minutes

    async function load() {
        try {
            const raw = localStorage.getItem(CACHE_KEY);
            if (raw) {
                const { d, t } = JSON.parse(raw);
                if (Date.now() - t < TTL) return d;
            }
            const r = await fetch('/api/site-settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'get_all' })
            });
            const j = await r.json();
            if (j.success && j.settings) {
                localStorage.setItem(CACHE_KEY, JSON.stringify({ d: j.settings, t: Date.now() }));
                return j.settings;
            }
        } catch (e) {
            console.warn('[site-config] failed to load settings:', e);
        }
        return {};
    }

    const cfg = await load();
    window.ppCfg = cfg;
    if (!Object.keys(cfg).length) return;

    // --- Logo ---
    // Match by class AND by src containing the known CDN domain
    if (cfg.logo_url) {
        document.querySelectorAll('img').forEach(el => {
            const isLogoClass = el.classList.contains('login-logo') || el.classList.contains('logo-img') ||
                                el.classList.contains('topbar-logo') || el.classList.contains('nav-logo') ||
                                el.classList.contains('sidebar-logo');
            const isLogoCdn  = el.src && (el.src.includes('filesafe.space') || el.src.includes('website-files.com'));
            if (isLogoClass || isLogoCdn) {
                el.src = cfg.logo_url;
                // login-logo starts hidden (no fallback src) — reveal once the CMS logo loads
                if (el.classList.contains('login-logo')) {
                    el.onload  = () => { el.style.display = 'block'; };
                    el.onerror = () => { el.style.display = 'none'; };
                }
            }
        });
    }

    // --- Favicon ---
    if (cfg.favicon_url) {
        let fav = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
        if (!fav) {
            fav = document.createElement('link');
            fav.rel = 'icon';
            fav.type = 'image/png';
            document.head.appendChild(fav);
        }
        fav.href = cfg.favicon_url;
    }

    // --- Brand colors — set ALL relevant CSS custom properties ---
    const R = document.documentElement;
    if (cfg.brand_color_primary) {
        R.style.setProperty('--pp-blue',   cfg.brand_color_primary);
        R.style.setProperty('--pp-mid',    cfg.brand_color_primary); // some pages use --pp-mid
    }
    if (cfg.brand_color_dark) {
        R.style.setProperty('--pp-navy',   cfg.brand_color_dark);
    }
    if (cfg.brand_color_accent) {
        R.style.setProperty('--pp-accent', cfg.brand_color_accent);
        R.style.setProperty('--pp-cyan',   cfg.brand_color_accent);
    }

    // --- Portal name — title + known heading classes ---
    if (cfg.portal_name && cfg.portal_name !== 'PayProTec') {
        document.title = document.title.replace(/PayProTec/gi, cfg.portal_name);
        document.querySelectorAll('.login-title, .brand-title, [data-cms="portal-name"]').forEach(el => {
            el.textContent = el.textContent.replace(/PayProTec/gi, cfg.portal_name);
        });
    }

    // --- AI name ---
    if (cfg.ai_name) {
        document.querySelectorAll('[data-cms="ai-name"]').forEach(el => {
            el.textContent = cfg.ai_name;
        });
    }

    // --- Software branding ---
    if (cfg.software_name || cfg.software_logo_url) {
        // Login card slot (index.html)
        const loginBrand = document.getElementById('login-sw-brand');
        if (loginBrand) {
            if (cfg.software_logo_url) {
                const logoEl = document.getElementById('login-sw-logo');
                if (logoEl) { logoEl.src = cfg.software_logo_url; logoEl.style.display = 'block'; }
            }
            if (cfg.software_name) {
                const nameEl = document.getElementById('login-sw-name');
                if (nameEl) nameEl.textContent = cfg.software_name;
            }
            loginBrand.style.display = 'flex';
        }

        // Global footer bar on all other pages
        if (!document.getElementById('pp-sw-footer')) {
            const bar = document.createElement('div');
            bar.id = 'pp-sw-footer';
            bar.style.cssText = [
                'position:fixed', 'bottom:0', 'left:0', 'right:0',
                'height:36px', 'background:#f1f5f9',
                'border-top:1px solid #e2e8f0',
                'display:flex', 'align-items:center', 'justify-content:center',
                'gap:8px', 'z-index:99998',
                'font-family:"DM Sans",sans-serif', 'font-size:10px',
                'font-weight:600', 'color:#94a3b8', 'letter-spacing:0.3px',
                'pointer-events:none', 'user-select:none'
            ].join(';');

            let inner = '<span style="opacity:0.7;">Powered by</span>';
            if (cfg.software_logo_url) {
                inner += `<img src="${cfg.software_logo_url}" alt="" style="height:22px;width:auto;max-width:120px;object-fit:contain;vertical-align:middle;">`;
            }
            if (cfg.software_name) {
                inner += `<span style="font-weight:800;color:#475569;">${cfg.software_name}</span>`;
            }
            bar.innerHTML = inner;
            document.body.appendChild(bar);

            // Ensure content doesn't hide behind the bar
            const pb = parseInt(window.getComputedStyle(document.body).paddingBottom) || 0;
            if (pb < 32) document.body.style.paddingBottom = '32px';
        }
    }
})();
