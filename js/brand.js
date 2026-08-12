// White-label theming applier for the PARTNER portal only.
// Resolves a brand by hostname (POST /api/brand {action:'resolve'}) and repaints
// the portal: primary/dark colors, sidebar + topbar logos, portal name, title, favicon.
//
// Safe by design:
//   • Only runs on /partner* pages. The staff console stays PayProTec, always.
//   • No brand for this host  → nothing changes (default PayProTec look).
//   • ?brand=<host> query override lets staff preview a brand without DNS/SSL.
//   • Sub-brands (per company, for partners with 2+ companies) can be applied
//     on top via window.applyCompanyBrand(sub) — used by the company switcher.
(function () {
    if (!/^\/partner(\/|$)/.test(window.location.pathname)) return; // portal only, not /partners-dashboard

    function qp(name) {
        try { return new URLSearchParams(window.location.search).get(name); } catch (e) { return null; }
    }

    // Host to resolve: ?brand= preview override wins, else the real hostname.
    var host = qp('brand') || window.location.hostname;

    // Skip our own canonical hosts — they are always PayProTec (no lookup needed),
    // unless a preview override was explicitly supplied.
    var CANONICAL = ['portal.mypayprotec.com', 'app.mypayprotec.com', 'localhost', '127.0.0.1'];
    if (!qp('brand') && CANONICAL.indexOf(host) !== -1) return;

    window._portalBrand = null;

    function setVar(name, val) {
        if (val) document.documentElement.style.setProperty(name, val);
    }

    function applyFavicon(url) {
        if (!url) return;
        var link = document.querySelector('link[rel~="icon"]');
        if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
        link.href = url;
    }

    // Swap every logo image to the brand logo. Brand logos are full-color, so we
    // drop the brightness(0) invert(1) filter that whitens the PayProTec mark.
    function applyLogos(url) {
        if (!url) return;
        document.querySelectorAll('.sidebar-logo, .topbar-logo').forEach(function (img) {
            img.src = url;
            img.style.filter = 'none';
        });
    }

    function applyName(name) {
        if (!name) return;
        // Sidebar footer version line ("PayProTec Partner Portal v1.0") + any element
        // opted-in via data-brand-name. Keep it conservative — don't rewrite body copy.
        document.querySelectorAll('[data-brand-name]').forEach(function (el) { el.textContent = name; });
        try {
            if (document.title) document.title = document.title.replace(/PayProTec/g, name);
        } catch (e) {}
    }

    function applyBrand(b) {
        if (!b) return;
        window._portalBrand = b;
        setVar('--teal', b.color_primary);
        setVar('--teal-dark', b.color_primary); // keep hover in-family unless accent set
        setVar('--navy', b.color_dark);
        if (b.color_accent) setVar('--teal-dark', b.color_accent);
        applyLogos(b.logo_url);
        applyFavicon(b.favicon_url);
        applyName(b.name);
        document.documentElement.setAttribute('data-branded', '1');

        // Re-apply logos shortly after: partner-nav.js / page scripts inject the
        // sidebar logo asynchronously, so a single pass can miss it.
        var tries = 0;
        var iv = setInterval(function () {
            applyLogos(b.logo_url);
            if (++tries >= 6) clearInterval(iv);
        }, 400);
    }

    // Public: apply a per-company sub-brand on top of the host brand (company switcher).
    // Passing null reverts to the host brand.
    window.applyCompanyBrand = function (sub) {
        if (!sub) { if (window._portalBrand) applyBrand(window._portalBrand); return; }
        setVar('--teal', sub.color_primary || (window._portalBrand && window._portalBrand.color_primary));
        setVar('--navy', sub.color_dark || (window._portalBrand && window._portalBrand.color_dark));
        applyLogos(sub.logo_url || (window._portalBrand && window._portalBrand.logo_url));
        applyName(sub.name || (window._portalBrand && window._portalBrand.name));
    };

    function resolve() {
        fetch('/api/brand', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'resolve', host: host })
        })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d && d.brand) applyBrand(d.brand); })
            .catch(function () { /* brand is best-effort; default look on failure */ });
    }

    // ── Company sub-brand switcher ──────────────────────────────────────────
    // Partners with 2+ companies (e.g. Michelle Malone) can carry a distinct
    // sub-brand per company. We fetch the partner's companies+sub-brands and, if
    // more than one exists, inject a compact switcher at the top of the sidebar.
    // Picking a company applies its sub-brand on top of the host brand.
    function initCompanySwitcher() {
        var token = localStorage.getItem('pp_partner_token');
        if (!token) return;
        fetch('/api/brand', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'my_brand', token: token })
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || !d.success) return;
                var companies = (d.companies || []);
                // Only worth a switcher when there are 2+ companies to switch between.
                if (companies.length < 2) return;
                buildSwitcher(companies);
            })
            .catch(function () {});
    }

    function buildSwitcher(companies) {
        function place() {
            var sidebar = document.querySelector('.sidebar');
            if (!sidebar || document.getElementById('brand-company-switcher')) return true;
            var wrap = document.createElement('div');
            wrap.id = 'brand-company-switcher';
            wrap.style.cssText = 'padding:10px 14px;border-bottom:1px solid rgba(255,255,255,0.08);';
            var saved = localStorage.getItem('pp_active_company') || '';
            var opts = companies.map(function (c) {
                var sel = String(c.company_id) === saved ? ' selected' : '';
                return '<option value="' + c.company_id + '"' + sel + '>' + (c.company_name || 'Company') + '</option>';
            }).join('');
            wrap.innerHTML = '<label style="display:block;font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:4px;">Company</label>'
                + '<select id="brand-company-select" style="width:100%;padding:7px 9px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:#fff;font-size:12px;font-weight:600;cursor:pointer;">' + opts + '</select>';
            // Insert just under the logo (first child area).
            var logo = sidebar.querySelector('.sidebar-logo');
            if (logo && logo.parentNode === sidebar) sidebar.insertBefore(wrap, logo.nextSibling);
            else sidebar.insertBefore(wrap, sidebar.firstChild);

            var sel = wrap.querySelector('#brand-company-select');
            function applySel() {
                var c = companies.filter(function (x) { return String(x.company_id) === sel.value; })[0];
                localStorage.setItem('pp_active_company', sel.value);
                window._activeCompanyId = sel.value;
                window.applyCompanyBrand(c && c.sub && c.sub.active !== false ? c.sub : null);
                document.dispatchEvent(new CustomEvent('companychange', { detail: { company_id: sel.value } }));
            }
            sel.addEventListener('change', applySel);
            if (saved) applySel(); // restore last-selected sub-brand
            return true;
        }
        // Sidebar may be injected asynchronously — retry briefly.
        if (place()) return;
        var tries = 0;
        var iv = setInterval(function () { if (place() || ++tries >= 10) clearInterval(iv); }, 400);
    }

    function boot() { resolve(); initCompanySwitcher(); }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
