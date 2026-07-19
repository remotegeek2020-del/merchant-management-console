/*
 * Global Command Palette — ⌘K / Ctrl-K quick search & jump.
 * Self-contained; loaded on every staff page via site-config.js. Searches
 * merchants, partners, agent IDs, deployments, returns, tickets, equipment &
 * tasks (via /api/search) plus in-app page navigation, and jumps straight to
 * the right place. No-ops if there's no staff session.
 */
(function () {
    'use strict';
    if (window.__ppCmd) return; window.__ppCmd = true;
    var TOKEN = localStorage.getItem('pp_session_token') || '';
    var UID = localStorage.getItem('pp_userid') || '';
    if (!TOKEN || !UID) return;

    // Static navigation targets (access-guard redirects if the user lacks access).
    var PAGES = [
        ['Home', '/', 'home'],
        ['Merchants', '/merchants-dashboard.html', 'storefront'],
        ['Deployments', '/deployments-dashboard.html', 'local_shipping'],
        ['Returns', '/returns-dashboard.html', 'assignment_return'],
        ['Equipment Inventory', '/equipments-dashboard.html', 'inventory_2'],
        ['Repair Queue', '/repair-queue.html', 'build'],
        ['Partners', '/partners-dashboard.html', 'handshake'],
        ['Tickets', '/tickets-dashboard.html', 'confirmation_number'],
        ['Task Center', '/tasks-dashboard.html', 'task_alt'],
        ['Admin Dashboard', '/admin-dashboard.html', 'dashboard'],
        ['Marketing', '/marketing.html', 'campaign'],
        ['Reports', '/reports-dashboard.html', 'summarize'],
        ['Analytics', '/analytics-dashboard.html', 'insights'],
        ['Activity Logs', '/activity-logs.html', 'receipt_long'],
        ['Residuals', '/residuals-ledger.html', 'payments'],
        ['Ideas', '/ideas-dashboard.html', 'lightbulb'],
        ['Staff Community', '/staff-community.html', 'groups'],
        ['User Management', '/user-management.html', 'manage_accounts'],
        ['Secret Dungeon', '/secret-dungeon.html', 'castle'],
        ['My Settings', '/staff-settings.html', 'settings']
    ];

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }
    function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }

    // ── styles ──
    var style = document.createElement('style');
    style.textContent = [
        '#ppcmd-ov{position:fixed;inset:0;z-index:2147483200;background:rgba(2,8,20,.5);display:none;align-items:flex-start;justify-content:center;padding:12vh 16px 16px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}',
        '#ppcmd-ov.open{display:flex;}',
        '.ppcmd-box{background:#fff;width:100%;max-width:600px;border-radius:14px;box-shadow:0 30px 80px rgba(0,0,0,.4);overflow:hidden;max-height:70vh;display:flex;flex-direction:column;}',
        '.ppcmd-inwrap{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #eef2f7;}',
        '.ppcmd-inwrap .material-icons{color:#94a3b8;}',
        '#ppcmd-input{flex:1;border:none;outline:none;font-size:16px;color:#0f172a;background:none;font-family:inherit;}',
        '.ppcmd-kbd{font-size:10px;font-weight:700;color:#94a3b8;border:1px solid #e2e8f0;border-radius:5px;padding:2px 6px;}',
        '#ppcmd-list{overflow-y:auto;padding:6px;}',
        '.ppcmd-group{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:#94a3b8;padding:10px 12px 4px;}',
        '.ppcmd-item{display:flex;align-items:center;gap:11px;padding:9px 12px;border-radius:9px;cursor:pointer;}',
        '.ppcmd-item.active{background:#eff6ff;}',
        '.ppcmd-ico{flex:none;width:30px;height:30px;border-radius:7px;background:#f1f5f9;display:flex;align-items:center;justify-content:center;}',
        '.ppcmd-ico .material-icons{font-size:17px;color:#475569;}',
        '.ppcmd-txt{flex:1;min-width:0;}',
        '.ppcmd-t{font-size:13px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.ppcmd-s{font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.ppcmd-empty{padding:26px 16px;text-align:center;color:#94a3b8;font-size:13px;}',
        '.ppcmd-foot{border-top:1px solid #eef2f7;padding:8px 14px;display:flex;gap:14px;font-size:10.5px;color:#94a3b8;}'
    ].join('');
    document.head.appendChild(style);

    var ov = document.createElement('div');
    ov.id = 'ppcmd-ov';
    ov.innerHTML =
        '<div class="ppcmd-box" role="dialog" aria-label="Command palette">' +
        '<div class="ppcmd-inwrap"><span class="material-icons">search</span>' +
        '<input id="ppcmd-input" placeholder="Search merchants, partners, tickets, tasks… or jump to a page" autocomplete="off" spellcheck="false">' +
        '<span class="ppcmd-kbd">ESC</span></div>' +
        '<div id="ppcmd-list"></div>' +
        '<div class="ppcmd-foot"><span>↑↓ navigate</span><span>↵ open</span><span>esc close</span></div>' +
        '</div>';
    document.body.appendChild(ov);

    var input = ov.querySelector('#ppcmd-input');
    var listEl = ov.querySelector('#ppcmd-list');
    var items = [];       // flat list of {title, sub, icon, url}
    var active = 0;
    var seq = 0;          // request sequencer to drop stale responses

    function open() {
        ov.classList.add('open');
        input.value = ''; input.focus();
        renderPages('');
    }
    function close() { ov.classList.remove('open'); }
    function isOpen() { return ov.classList.contains('open'); }

    // Map API result rows → palette items.
    function mapResults(r) {
        var out = [];
        (r.merchants || []).forEach(function (m) { out.push({ group: 'Merchants', title: m.dba_name || m.merchant_id, sub: (m.merchant_id || '') + (m.account_status ? ' · ' + m.account_status : ''), icon: 'storefront', url: '/merchants-dashboard.html?nm=' + enc(m.id) }); });
        (r.partners || []).forEach(function (p) { out.push({ group: 'Partners', title: p.full_name || p.email, sub: p.email || '', icon: 'handshake', url: '/partners-dashboard.html?q=' + enc(p.full_name || p.email) }); });
        (r.agent_ids || []).forEach(function (a) { out.push({ group: 'Agent IDs', title: a.id_string, sub: 'Agent ID', icon: 'badge', url: '/partners-dashboard.html?q=' + enc(a.id_string) }); });
        (r.deployments || []).forEach(function (d) { out.push({ group: 'Deployments', title: d.deployment_id || d.tracking_id || 'Deployment', sub: (d.merchant_name || '') + (d.status ? ' · ' + d.status : ''), icon: 'local_shipping', url: '/deployments-dashboard.html?q=' + enc(d.deployment_id || d.tracking_id || '') }); });
        (r.returns || []).forEach(function (x) { out.push({ group: 'Returns', title: x.return_id || 'Return', sub: (x.merchant_name || '') + (x.status ? ' · ' + x.status : ''), icon: 'assignment_return', url: '/returns-dashboard.html?q=' + enc(x.return_id || '') }); });
        (r.tickets || []).forEach(function (t) { out.push({ group: 'Tickets', title: (t.ticket_number || '') + ' — ' + (t.subject || ''), sub: (t.status || '') + (t.priority ? ' · ' + t.priority : ''), icon: 'confirmation_number', url: '/tickets-dashboard.html?q=' + enc(t.ticket_number || '') }); });
        (r.equipment || []).forEach(function (e) { out.push({ group: 'Equipment', title: e.serial_number, sub: (e.terminal_type || '') + (e.status ? ' · ' + e.status : ''), icon: 'inventory_2', url: '/equipments-dashboard.html?q=' + enc(e.serial_number) }); });
        (r.tasks || []).forEach(function (t) { out.push({ group: 'Tasks', title: t.title || 'Task', sub: (t.merchant_name || '') + (t.status ? ' · ' + t.status : ''), icon: 'task_alt', url: '/tasks-dashboard.html?highlight=' + enc(t.id) }); });
        return out;
    }

    function pageItems(q) {
        var ql = q.toLowerCase();
        return PAGES.filter(function (p) { return !ql || p[0].toLowerCase().indexOf(ql) !== -1; })
            .map(function (p) { return { group: 'Go to', title: p[0], sub: p[1], icon: p[2], url: p[1] }; });
    }

    function paint() {
        if (!items.length) { listEl.innerHTML = '<div class="ppcmd-empty">No matches. Try a name, MID, serial, ticket #, or a page.</div>'; return; }
        if (active >= items.length) active = items.length - 1;
        if (active < 0) active = 0;
        var html = ''; var lastGroup = null;
        items.forEach(function (it, i) {
            if (it.group !== lastGroup) { html += '<div class="ppcmd-group">' + esc(it.group) + '</div>'; lastGroup = it.group; }
            html += '<div class="ppcmd-item' + (i === active ? ' active' : '') + '" data-i="' + i + '">' +
                '<span class="ppcmd-ico"><span class="material-icons">' + esc(it.icon) + '</span></span>' +
                '<span class="ppcmd-txt"><span class="ppcmd-t">' + esc(it.title) + '</span>' +
                (it.sub ? '<span class="ppcmd-s">' + esc(it.sub) + '</span>' : '') + '</span></div>';
        });
        listEl.innerHTML = html;
        Array.prototype.forEach.call(listEl.querySelectorAll('.ppcmd-item'), function (el) {
            el.addEventListener('mouseenter', function () { active = +el.getAttribute('data-i'); highlight(); });
            el.addEventListener('click', function () { go(+el.getAttribute('data-i')); });
        });
        scrollActive();
    }
    function highlight() {
        Array.prototype.forEach.call(listEl.querySelectorAll('.ppcmd-item'), function (el) {
            el.classList.toggle('active', +el.getAttribute('data-i') === active);
        });
    }
    function scrollActive() {
        var el = listEl.querySelector('.ppcmd-item.active');
        if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function go(i) { var it = items[i]; if (it) location.href = it.url; }

    function renderPages(q) { items = pageItems(q); active = 0; paint(); }

    var timer = null;
    function onInput() {
        var q = input.value.trim();
        if (timer) clearTimeout(timer);
        if (q.length < 2) { renderPages(q); return; }
        // Show pages instantly; merge server results when they arrive.
        items = pageItems(q); active = 0; paint();
        var mySeq = ++seq;
        timer = setTimeout(function () {
            fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN }, body: JSON.stringify({ q: q, userid: UID }) })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (mySeq !== seq) return;   // stale
                    if (d && d.success && d.results) { items = mapResults(d.results).concat(pageItems(q)); active = 0; paint(); }
                }).catch(function () {});
        }, 200);
    }

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); highlight(); scrollActive(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); scrollActive(); }
        else if (e.key === 'Enter') { e.preventDefault(); go(active); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });

    // Global hotkey: ⌘K / Ctrl-K (toggles).
    document.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            isOpen() ? close() : open();
        }
    });

    // Expose a programmatic opener (e.g. a header button can call window.ppCmdOpen()).
    window.ppCmdOpen = open;
})();
