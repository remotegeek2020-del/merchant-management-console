// Shared partner sidebar nav badge polling + notification bell.
// Include on every partner page after site-config.js.
(function () {
    var token = localStorage.getItem('pp_partner_token');
    var myId = localStorage.getItem('pp_partner_id');
    if (!token || !window.location.pathname.startsWith('/partner')) return;

    // Shared session-expiry guard: a 401 from a PARTNER-authenticated endpoint
    // means the partner session expired — clear and re-login. IMPORTANT: only
    // partner-token endpoints count. Partner pages also fire harmless 401s from
    // staff-context endpoints (e.g. the shared Messenger polling /api/chat, the
    // notification bell hitting /api/merchants) — those must NOT log the partner
    // out. (Mirrors the staff guard, which only logs out when its own token was
    // actually rejected.)
    (function () {
        var PARTNER_APIS = ['/api/partner-auth', '/api/partner-data', '/api/community', '/api/courses', '/api/pos'];
        var _fetch = window.fetch, redirected = false;
        window.fetch = function (u, opts) {
            return _fetch(u, opts).then(function (res) {
                try {
                    var url = typeof u === 'string' ? u : (u && u.url) || '';
                    var isPartnerApi = PARTNER_APIS.some(function (p) { return url.indexOf(p) !== -1; });
                    if (res.status === 401 && isPartnerApi && !redirected) {
                        redirected = true;
                        localStorage.clear();
                        window.location.href = '/partner';
                    }
                } catch (e) {}
                return res;
            });
        };
    })();

    // Inject nav-badge style if not already present
    if (!document.getElementById('pnav-style')) {
        var s = document.createElement('style');
        s.id = 'pnav-style';
        // nav badge + make the sidebar nav scroll so injected items never overflow/clip
        // the fixed-height sidebar (some partner pages don't set overflow on .sidebar-nav).
        s.textContent = '.nav-badge{background:#ef4444;color:white;border-radius:99px;font-size:9px;font-weight:800;padding:1px 6px;margin-left:auto;line-height:1.4;}'
            + '.sidebar-nav{overflow-y:auto;min-height:0;}';
        document.head.appendChild(s);
    }

    // ── NOTIFICATION BELL ────────────────────────────────────
    function injectNotificationBell() {
        var topbar = document.querySelector('.topbar');
        // Skip if already injected, or if this page has its own native bell
        // (e.g. community's richer notif panel) — one bell per page.
        if (!topbar || document.getElementById('pnav-bell') || document.querySelector('.notif-bell')) return;
        var bell = document.createElement('div');
        bell.id = 'pnav-bell';
        bell.style.cssText = 'position:relative;display:inline-flex;align-items:center;flex-shrink:0;';
        bell.innerHTML = '<button onclick="window.pnavShowNotifications()" style="background:none;border:1px solid #e2e8f0;border-radius:10px;padding:7px 9px;cursor:pointer;display:flex;align-items:center;color:#475569;transition:all 0.2s;" onmouseover="this.style.borderColor=\'#0d9488\';this.style.color=\'#0d9488\'" onmouseout="this.style.borderColor=\'#e2e8f0\';this.style.color=\'#475569\'" title="Notifications"><span class="material-icons" style="font-size:20px;">notifications</span></button><span id="pnav-notif-badge" style="display:none;position:absolute;top:-5px;right:-5px;background:#ef4444;color:white;border-radius:99px;font-size:9px;font-weight:800;padding:1px 5px;min-width:16px;text-align:center;line-height:1.5;pointer-events:none;"></span>';
        // Insert before the last child (action buttons area)
        var lastChild = topbar.lastElementChild;
        if (lastChild && lastChild.tagName !== 'H1') {
            topbar.insertBefore(bell, lastChild);
        } else {
            topbar.appendChild(bell);
        }
    }

    function setNotifBadge(count) {
        var b = document.getElementById('pnav-notif-badge');
        if (!b) return;
        if (count > 0) { b.textContent = count > 99 ? '99+' : count; b.style.display = 'inline'; }
        else { b.style.display = 'none'; }
    }

    window.pnavShowNotifications = async function () {
        Swal.fire({ title: 'Notifications', html: '<div style="text-align:center;padding:20px;color:#94a3b8;">Loading...</div>', showConfirmButton: false, showCloseButton: true, width: 520 });
        try {
            var r = await fetch('/api/partner-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_notifications', token }) });
            var d = await r.json();
            if (!d.success) { Swal.update({ html: '<p style="color:#ef4444;">Failed to load notifications.</p>' }); return; }
            var notifs = d.notifications || [];
            if (!notifs.length) {
                Swal.update({ html: '<div style="text-align:center;padding:30px;color:#94a3b8;"><span class="material-icons" style="font-size:40px;opacity:0.3;display:block;margin-bottom:8px;">notifications_none</span><p style="margin:0;">No notifications yet</p></div>' });
                return;
            }
            var html = '<div style="max-height:420px;overflow-y:auto;">' + notifs.map(function(n) {
                var isRisk = n.type === 'risk_alert';
                var bg = n.is_read ? '#f8fafc' : '#fff7ed';
                var border = n.is_read ? '#e2e8f0' : '#fed7aa';
                var icon = isRisk ? 'warning' : 'notifications';
                var iconColor = isRisk ? '#ef4444' : '#0d9488';
                var date = n.created_at ? new Date(n.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
                var hasLink = n.link && n.link.trim();
                var clickAttr = hasLink ? 'onclick="Swal.close();window.location.href=\'' + n.link + '\';" style="cursor:pointer;" onmouseover="this.style.borderColor=\'' + (isRisk ? '#fca5a5' : '#99f6e4') + '\';" onmouseout="this.style.borderColor=\'' + border + '\';"' : '';
                return '<div ' + clickAttr + ' style="background:' + bg + ';border:1px solid ' + border + ';border-radius:10px;padding:12px 14px;margin-bottom:8px;text-align:left;transition:border-color 0.15s;">' +
                    '<div style="display:flex;align-items:flex-start;gap:10px;">' +
                    '<span class="material-icons" style="font-size:18px;color:' + iconColor + ';margin-top:1px;flex-shrink:0;">' + icon + '</span>' +
                    '<div style="flex:1;min-width:0;">' +
                    '<div style="font-size:13px;font-weight:700;color:#0a1628;margin-bottom:3px;">' + (n.title||'') + '</div>' +
                    (n.body ? '<div style="font-size:12px;color:#475569;line-height:1.5;margin-bottom:4px;">' + n.body + '</div>' : '') +
                    '<div style="font-size:10px;color:#94a3b8;display:flex;align-items:center;gap:6px;">' + (n.actor_name ? 'From: ' + n.actor_name + ' · ' : '') + date + (hasLink ? ' <span style="color:' + iconColor + ';font-weight:700;">View →</span>' : '') + '</div>' +
                    '</div></div></div>';
            }).join('') + '</div>';
            if (d.unread > 0) {
                html = '<div style="display:flex;justify-content:flex-end;margin-bottom:10px;"><button onclick="window.pnavMarkAllRead()" style="background:none;border:none;color:#0d9488;font-size:12px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif;padding:0;">Mark all as read</button></div>' + html;
            }
            Swal.update({ html });
            setNotifBadge(0);
            // Auto-mark as read after viewing
            fetch('/api/partner-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mark_notifications_read', token }) });
        } catch(e) {
            Swal.update({ html: '<p style="color:#ef4444;">Error loading notifications.</p>' });
        }
    };

    window.pnavMarkAllRead = async function() {
        await fetch('/api/partner-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mark_notifications_read', token }) });
        setNotifBadge(0);
        window.pnavShowNotifications();
    };

    function ensureBadge(navLink, id) {
        if (!navLink || navLink.querySelector('#' + id)) return;
        var b = document.createElement('span');
        b.id = id;
        b.className = 'nav-badge';
        b.style.display = 'none';
        navLink.appendChild(b);
    }

    function injectBadges() {
        document.querySelectorAll('.sidebar-nav a.nav-item, .sidebar-nav .nav-item').forEach(function (link) {
            var href = link.getAttribute('href') || '';
            if (href.indexOf('/partner/messages') !== -1) ensureBadge(link, 'navDmBadge');
            if (href.indexOf('/partner/tickets') !== -1) ensureBadge(link, 'navTicketBadge');
        });
    }

    function setBadge(id, count) {
        var el = document.getElementById(id);
        if (!el) return;
        if (count > 0) { el.textContent = count > 99 ? '99+' : count; el.style.display = 'inline'; }
        else { el.style.display = 'none'; }
    }

    async function pollNav() {
        if (document.hidden) return;
        // Ticket unread total
        try {
            var tr = await fetch('/api/tickets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'get_unread_total', token: token })
            });
            var td = await tr.json();
            if (td.success) setBadge('navTicketBadge', td.total || 0);
        } catch (e) {}
        // DM unread count
        if (!myId) { myId = localStorage.getItem('pp_partner_id'); }
        if (myId) {
            try {
                var mr = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'getUnreadCount', sender_id: myId, partner_token: token })
                });
                var md = await mr.json();
                if (md.success) setBadge('navDmBadge', md.count || 0);
            } catch (e) {}
        }
        // Notification bell unread count
        try {
            var nr = await fetch('/api/partner-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'get_notifications', token: token })
            });
            var nd = await nr.json();
            if (nd.success) setNotifBadge(nd.unread || 0);
        } catch (e) {}
    }

    function injectBrandedBadge() {
        if (localStorage.getItem('pp_is_branded') !== '1') return;
        var tag = document.querySelector('.sidebar-tag');
        if (!tag || document.getElementById('pnav-branded-badge')) return;
        var badge = document.createElement('div');
        badge.id = 'pnav-branded-badge';
        badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:linear-gradient(135deg,#004990,#0369a1);color:white;font-size:8px;font-weight:800;padding:2px 7px;border-radius:99px;letter-spacing:0.5px;margin-top:4px;';
        badge.innerHTML = '&#127991;&#65039; BRANDED';
        tag.parentNode.insertBefore(badge, tag.nextSibling);
    }

    // Inject "Home" (the launchpad / agency hub) at the top of the sidebar on every
    // partner page, so multi-agency/multi-company partners always have their hub.
    function injectHomeNav() {
        var nav = document.querySelector('.sidebar-nav');
        if (!nav || nav.querySelector('a[href="/partner/home"]')) return;
        var a = document.createElement('a');
        a.className = 'nav-item' + (window.location.pathname.indexOf('/partner/home') !== -1 ? ' active' : '');
        a.href = '/partner/home';
        a.innerHTML = '<span class="material-icons">home</span> Home';
        nav.insertBefore(a, nav.firstChild);
    }

    // Add the "My Prime49" nav item on every partner page (after My Merchants),
    // so the sidebar stays consistent without editing all page files.
    function injectResidualsNav() {
        var nav = document.querySelector('.sidebar-nav');
        if (!nav || nav.querySelector('a[href="/partner/residuals"]')) return;
        var merchants = nav.querySelector('a[href="/partner/merchants"]');
        if (!merchants) return;
        var a = document.createElement('a');
        a.className = 'nav-item' + (window.location.pathname.indexOf('/partner/residuals') !== -1 ? ' active' : '');
        a.href = '/partner/residuals';
        a.innerHTML = '<span class="material-icons">payments</span> Residuals';
        merchants.parentNode.insertBefore(a, merchants.nextSibling);
    }

    // Inject "Leaderboard" into the sidebar on every partner page (after Sub-Partners
    // when present, else near the top). Hidden by the section toggle via applySections.
    function injectLeaderboardNav() {
        var nav = document.querySelector('.sidebar-nav');
        if (!nav || nav.querySelector('a[href="/partner/leaderboard"]')) return;
        var anchor = nav.querySelector('a[href="/partner/sub-partners"]') || nav.querySelector('a[href="/partner/webinars"]') || nav.querySelector('a[href="/partner/residuals"]');
        var a = document.createElement('a');
        a.className = 'nav-item' + (window.location.pathname.indexOf('/partner/leaderboard') !== -1 ? ' active' : '');
        a.href = '/partner/leaderboard';
        a.innerHTML = '<span class="material-icons">leaderboard</span> Leaderboard';
        if (anchor) anchor.parentNode.insertBefore(a, anchor.nextSibling);
        else nav.appendChild(a);
    }

    // Inject "Submit POS Lead" into the sidebar on every partner page.
    function injectPosLeadNav() {
        var nav = document.querySelector('.sidebar-nav');
        if (!nav || nav.querySelector('a[href="/partner/pos-lead"]')) return;
        var merchants = nav.querySelector('a[href="/partner/merchants"]');
        if (!merchants) return;
        var a = document.createElement('a');
        a.className = 'nav-item' + (window.location.pathname.indexOf('/partner/pos-lead') !== -1 ? ' active' : '');
        a.href = '/partner/pos-lead';
        a.innerHTML = '<span class="material-icons">point_of_sale</span> Submit POS Lead';
        merchants.parentNode.insertBefore(a, merchants.nextSibling);
    }

    // ── PARTNER PORTAL SECTION TOGGLES ───────────────────────────
    // Admin can turn portal sections off (Marketing → Partner Portal → Sections).
    // Hide the sidebar link for a disabled section, and bounce off its page.
    var SECTION_PATHS = {
        certificate: '/partner/certificate',
        community: '/partner/community',
        webinars: '/partner/webinars',
        leaderboard: '/partner/leaderboard'
    };
    function applySections() {
        fetch('/api/partner-portal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'public_config' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || !d.success || !d.sections) return;
                window.PP_SECTIONS = d.sections;
                var path = window.location.pathname;
                Object.keys(SECTION_PATHS).forEach(function (key) {
                    if (d.sections[key] === false) {
                        var href = SECTION_PATHS[key];
                        document.querySelectorAll('.sidebar-nav a[href="' + href + '"]').forEach(function (a) { a.style.display = 'none'; });
                        if (path.indexOf(href) === 0) window.location.href = '/partner/dashboard';
                    }
                });
            }).catch(function () {});
    }

    function init() {
        injectBadges();
        injectHomeNav();
        injectResidualsNav();
        injectLeaderboardNav();
        injectPosLeadNav();
        injectNotificationBell();
        injectBrandedBadge();
        applySections();
        pollNav();
        setInterval(function () { pollNav(); }, 30000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
