// Shared partner sidebar nav badge polling.
// Include on every partner page after site-config.js.
(function () {
    var token = localStorage.getItem('pp_partner_token');
    var myId = localStorage.getItem('pp_partner_id');
    if (!token || !window.location.pathname.startsWith('/partner')) return;

    // Inject nav-badge style if not already present
    if (!document.getElementById('pnav-style')) {
        var s = document.createElement('style');
        s.id = 'pnav-style';
        s.textContent = '.nav-badge{background:#ef4444;color:white;border-radius:99px;font-size:9px;font-weight:800;padding:1px 6px;margin-left:auto;line-height:1.4;}';
        document.head.appendChild(s);
    }

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
    }

    function init() {
        injectBadges();
        pollNav();
        setInterval(function () { pollNav(); }, 30000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
