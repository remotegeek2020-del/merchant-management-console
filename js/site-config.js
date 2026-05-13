(async function () {
    'use strict';
    const CACHE_KEY = 'pp_sc';
    const TTL = 5 * 60 * 1000;

    async function load() {
        try {
            const raw = sessionStorage.getItem(CACHE_KEY);
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
                sessionStorage.setItem(CACHE_KEY, JSON.stringify({ d: j.settings, t: Date.now() }));
                return j.settings;
            }
        } catch (_) {}
        return {};
    }

    const cfg = await load();
    window.ppCfg = cfg;
    if (!Object.keys(cfg).length) return;

    // Logo — target all common logo image classes
    if (cfg.logo_url) {
        document.querySelectorAll('img.login-logo, img.logo-img, img.topbar-logo, img.nav-logo, img.sidebar-logo').forEach(el => {
            if (el.src !== cfg.logo_url) el.src = cfg.logo_url;
        });
    }

    // Favicon
    if (cfg.favicon_url) {
        const fav = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
        if (fav && fav.getAttribute('href') !== cfg.favicon_url) fav.href = cfg.favicon_url;
    }

    // Brand CSS variables
    const R = document.documentElement;
    if (cfg.brand_color_primary) R.style.setProperty('--pp-blue', cfg.brand_color_primary);
    if (cfg.brand_color_dark)    R.style.setProperty('--pp-navy', cfg.brand_color_dark);
    if (cfg.brand_color_accent)  R.style.setProperty('--pp-accent', cfg.brand_color_accent);

    // Portal name — page title + known heading classes
    if (cfg.portal_name) {
        document.title = document.title.replace(/PayProTec/gi, cfg.portal_name);
        document.querySelectorAll('.login-title, .brand-title, [data-cms="portal-name"]').forEach(el => {
            el.textContent = el.textContent.replace(/PayProTec/gi, cfg.portal_name);
        });
    }

    // AI assistant name
    if (cfg.ai_name) {
        document.querySelectorAll('[data-cms="ai-name"]').forEach(el => {
            el.textContent = cfg.ai_name;
        });
    }
})();
