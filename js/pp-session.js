// Per-tab impersonation isolation for staff "Login As".
// MUST be the FIRST script in <head> on every partner page (before any inline script
// reads pp_partner_token).
//
// Problem: staff and partner portals share one same-origin localStorage, and the staff
// gatekeeper aggressively clears it — so a same-browser "Login As" and a staff session
// stomp each other (mutual logout, 2FA re-prompt).
//
// Fix: an impersonation tab keeps its partner session in sessionStorage (per-tab) and
// transparently redirects ALL partner-key localStorage operations to sessionStorage for
// THIS tab only. The shared localStorage (staff session) is never touched, and other
// tabs / normal partner logins are unaffected.
(function () {
    var PK = ['pp_partner_token', 'pp_partner_id', 'pp_impersonating', 'pp_partner_name',
              'pp_partner_email', 'pp_is_branded', 'pp_active_portal', 'pp_active_sub_account',
              'pp_active_company'];

    // 1) Handoff: staff opens /partner/home?imp=<token>&pid=<id>&as=<name>. Capture into
    //    sessionStorage, flag this tab as impersonation, then strip the params from the URL.
    try {
        var q = new URLSearchParams(window.location.search);
        var imp = q.get('imp');
        if (imp) {
            sessionStorage.setItem('pp_imp_mode', '1');
            sessionStorage.setItem('pp_partner_token', imp);
            if (q.get('pid')) sessionStorage.setItem('pp_partner_id', q.get('pid'));
            if (q.get('as')) sessionStorage.setItem('pp_impersonating', decodeURIComponent(q.get('as')));
            q.delete('imp'); q.delete('pid'); q.delete('as');
            var clean = window.location.pathname + (q.toString() ? ('?' + q.toString()) : '') + window.location.hash;
            window.history.replaceState(null, '', clean);
        }
    } catch (e) {}

    // 2) Only if THIS tab is an impersonation tab, overlay partner keys onto sessionStorage.
    if (sessionStorage.getItem('pp_imp_mode') !== '1') return;

    var _get = localStorage.getItem.bind(localStorage);
    var _set = localStorage.setItem.bind(localStorage);
    var _rem = localStorage.removeItem.bind(localStorage);
    var isPK = function (k) { return PK.indexOf(k) >= 0; };

    localStorage.getItem = function (k) { return isPK(k) ? sessionStorage.getItem(k) : _get(k); };
    localStorage.setItem = function (k, v) { if (isPK(k)) { sessionStorage.setItem(k, v); return; } return _set(k, v); };
    localStorage.removeItem = function (k) { if (isPK(k)) { sessionStorage.removeItem(k); return; } return _rem(k); };
    // clear() in an impersonation tab must NEVER wipe the shared (staff) localStorage —
    // it only ends this tab's impersonation.
    localStorage.clear = function () { PK.concat(['pp_imp_mode']).forEach(function (k) { sessionStorage.removeItem(k); }); };

    // Exit impersonation cleanly (used by the banner).
    window.ppExitImpersonation = function () {
        PK.concat(['pp_imp_mode']).forEach(function (k) { sessionStorage.removeItem(k); });
        try { window.open('', '_self'); window.close(); } catch (e) {}
        setTimeout(function () { window.location.href = '/partners-dashboard'; }, 80);
    };
})();
