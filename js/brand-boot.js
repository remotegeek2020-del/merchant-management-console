// Runs SYNCHRONOUSLY in <head>, before the body paints, to kill brand "flash":
//   1. On a branded (non-canonical) host, the navy sidebar's whitening filter
//      (brightness(0) invert(1)) would ruin a full-color brand logo. We drop it
//      up-front so the logo from /api/brand-logo renders correctly on first paint.
//   2. Apply the last-known brand COLORS from cache instantly, so colors don't
//      flash from PayProTec teal to the brand color. brand.js revalidates and
//      refreshes the cache asynchronously after load.
// Canonical PayProTec hosts are left completely untouched (default look).
(function () {
    try {
        var CANON = ['portal.mypayprotec.com', 'app.mypayprotec.com', 'localhost', '127.0.0.1'];
        var host = location.hostname;
        if (CANON.indexOf(host) !== -1) return; // canonical → always PayProTec, no changes

        document.documentElement.setAttribute('data-branded', '1');
        var s = document.createElement('style');
        s.textContent = '.sidebar-logo,.topbar-logo,.logo,[data-brand-logo]{filter:none !important;}';
        (document.head || document.documentElement).appendChild(s);

        var c = null;
        try { c = JSON.parse(localStorage.getItem('pp_brand:' + host) || 'null'); } catch (e) {}
        if (c) {
            var d = document.documentElement.style;
            if (c.color_primary) { d.setProperty('--teal', c.color_primary); d.setProperty('--teal-dark', c.color_accent || c.color_primary); }
            if (c.color_dark) { d.setProperty('--navy', c.color_dark); }
        }
    } catch (e) { /* best-effort; page still works */ }
})();
