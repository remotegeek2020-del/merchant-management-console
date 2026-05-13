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
            if ((isLogoClass || isLogoCdn) && el.src !== cfg.logo_url) el.src = cfg.logo_url;
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

    // --- Software branding footer ---
    if (cfg.software_name || cfg.software_logo_url) {
        // Don't double-inject
        if (!document.getElementById('pp-sw-footer')) {
            const bar = document.createElement('div');
            bar.id = 'pp-sw-footer';
            bar.style.cssText = [
                'position:fixed', 'bottom:0', 'left:0', 'right:0',
                'height:28px', 'background:rgba(255,255,255,0.92)',
                'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
                'border-top:1px solid #e2e8f0',
                'display:flex', 'align-items:center', 'justify-content:center',
                'gap:6px', 'z-index:99999',
                'font-family:"DM Sans",sans-serif', 'font-size:10px',
                'font-weight:600', 'color:#94a3b8', 'letter-spacing:0.3px',
                'pointer-events:none', 'user-select:none'
            ].join(';');

            let inner = '<span>Powered by</span>';
            if (cfg.software_logo_url) {
                inner += `<img src="${cfg.software_logo_url}" alt="" style="height:14px;width:auto;object-fit:contain;vertical-align:middle;">`;
            }
            if (cfg.software_name) {
                inner += `<span style="font-weight:800;color:#64748b;">${cfg.software_name}</span>`;
            }
            bar.innerHTML = inner;
            document.body.appendChild(bar);

            // Push page content up so footer doesn't overlap
            document.body.style.paddingBottom = 'max(' + (document.body.style.paddingBottom || '0px') + ', 32px)';
        }
    }
})();
