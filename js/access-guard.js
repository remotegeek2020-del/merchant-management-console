/*
 * Module access guard. Redirects to home if the logged-in staff member does
 * NOT have access to the current module. Strictly additive & non-breaking:
 *   - Admins / operations admins / super_admins always pass.
 *   - Only denies when the module's access flag is EXPLICITLY 'false'
 *     (missing/unknown = allowed), so nobody is locked out by default.
 * Access flags are set in localStorage at login (see js/script.js).
 * Include this early in <head> on module pages.
 */
(function () {
    try {
        var role = (localStorage.getItem('pp_role') || '').toLowerCase();
        if (role.indexOf('super') !== -1 || role === 'admin' || role === 'operations admin') return;

        var page = (location.pathname.split('/').pop() || '').toLowerCase();
        var MAP = {
            'merchants-dashboard.html': 'pp_access_merchants',
            'merchant-applications.html': 'pp_access_merchants',
            'deployments-dashboard.html': 'pp_access_deployments',
            'returns-dashboard.html': 'pp_access_returns',
            'equipments-dashboard.html': 'pp_access_inventory',
            'equipment-roi.html': 'pp_access_inventory',
            'repair-queue.html': 'pp_access_inventory',
            'partners-dashboard.html': 'pp_access_partners',
            'admin-dashboard.html': 'pp_access_admin_dashboard'
        };
        var flag = MAP[page];
        if (!flag) return;
        if (localStorage.getItem(flag) === 'false') {
            location.href = '/?reason=denied';
        }
    } catch (e) { /* never block the page on guard errors */ }
})();
