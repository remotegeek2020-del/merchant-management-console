/*
 * Shared notification bell — a self-contained floating widget for staff pages.
 * Shows the same in-app notifications as the Merchants Dashboard bell
 * (user_notifications via /api/merchants get_my_notifications).
 *
 * Safe to include anywhere: it no-ops if there's no staff session, and skips
 * itself if the page already has a native bell (#notif-bell-btn).
 */
(function () {
    'use strict';
    var TOKEN = localStorage.getItem('pp_session_token') || '';
    var UID = localStorage.getItem('pp_userid') || '';
    if (!TOKEN || !UID) return;                       // not a logged-in staff page
    if (document.getElementById('notif-bell-btn')) return; // native bell already here

    // Public Supabase config (anon key — same as the homepage realtime badges).
    var SB_URL = 'https://zuzwljjrppyrzngmhdru.supabase.co';
    var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1endsampycHB5cnpuZ21oZHJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1NjI3NjQsImV4cCI6MjA4ODEzODc2NH0.C7883WzNJIyqrc5vcWrOFPPDfjq7DAZhw2oQKFpwoow';

    var notifs = [];
    var _knownIds = {};   // ids we've already seen (to detect brand-new ones for push)
    var _primed = false;  // skip push on the very first load

    function api(body) {
        return fetch('/api/merchants', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).catch(function () { return { success: false }; });
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }
    function fmt(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return ''; } }

    // ── DOM ──
    // Avoid overlapping the JARVIS float button (bottom:54px right:24px) when present.
    var hasJarvis = !!document.getElementById('jarvis-trigger');
    var pos = hasJarvis ? 'right:24px;bottom:118px;' : 'right:18px;bottom:74px;';
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;' + pos + 'z-index:99991;font-family:system-ui,Segoe UI,Arial,sans-serif;';
    wrap.innerHTML =
        '<button id="nb-btn" title="Notifications" style="position:relative;width:44px;height:44px;border-radius:50%;border:1px solid #e2e8f0;background:#fff;cursor:pointer;color:#334155;box-shadow:0 4px 14px rgba(0,0,0,.12);display:flex;align-items:center;justify-content:center;">' +
        '<span class="material-icons" style="font-size:22px;">notifications</span>' +
        '<span id="nb-badge" style="display:none;position:absolute;top:6px;right:6px;min-width:16px;height:16px;padding:0 4px;border-radius:9px;background:#e11d48;color:#fff;font-size:10px;font-weight:800;line-height:16px;text-align:center;border:2px solid #fff;"></span>' +
        '</button>' +
        '<div id="nb-panel" style="display:none;position:absolute;right:0;bottom:52px;width:340px;max-width:90vw;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.16);overflow:hidden;">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid #f1f5f9;">' +
        '<div><div style="font-size:13px;font-weight:800;color:#0f172a;">Notifications</div>' +
        '<div style="font-size:10px;color:#94a3b8;margin-top:1px;">Tasks assigned to you, @mentions &amp; alerts</div></div>' +
        '<button id="nb-markall" style="font-size:11px;font-weight:700;color:#004990;background:none;border:none;cursor:pointer;white-space:nowrap;">Mark all read</button>' +
        '</div><div id="nb-list" style="max-height:60vh;overflow-y:auto;"></div></div>';
    document.body.appendChild(wrap);

    var btn = wrap.querySelector('#nb-btn');
    var badge = wrap.querySelector('#nb-badge');
    var panel = wrap.querySelector('#nb-panel');

    function renderBadge() {
        var n = notifs.filter(function (x) { return !x.is_read; }).length;
        badge.style.display = n > 0 ? 'block' : 'none';
        badge.textContent = n > 9 ? '9+' : String(n);
    }
    function renderList() {
        var list = wrap.querySelector('#nb-list');
        if (!notifs.length) {
            list.innerHTML = '<div style="text-align:center;padding:28px 16px;color:#94a3b8;font-size:13px;">No notifications</div>';
            return;
        }
        list.innerHTML = notifs.map(function (n) {
            var isAlert = n.type === 'alert';
            var isMention = n.type === 'mention';
            var icon = isAlert ? 'warning_amber' : isMention ? 'alternate_email' : 'task_alt';
            var color = isAlert ? '#b45309' : isMention ? '#7c3aed' : '#0369a1';
            var bg = isAlert ? '#fffbeb' : isMention ? '#faf5ff' : '#f0f9ff';
            var unread = !n.is_read;
            return '<div data-id="' + n.id + '" data-mid="' + esc(n.merchant_id || '') + '" data-mname="' + esc(n.merchant_name || '') + '" class="nb-item" ' +
                'style="display:flex;gap:10px;padding:11px 14px;cursor:pointer;border-bottom:1px solid #f8fafc;background:' + (unread ? '#fafafa' : '#fff') + ';">' +
                '<div style="flex-shrink:0;width:32px;height:32px;border-radius:50%;background:' + bg + ';display:flex;align-items:center;justify-content:center;">' +
                '<span class="material-icons" style="font-size:17px;color:' + color + ';">' + icon + '</span></div>' +
                '<div style="flex:1;min-width:0;">' +
                '<div style="font-size:12px;font-weight:' + (unread ? '700' : '600') + ';color:#0f172a;">' + esc(n.title || '') + (unread ? ' <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#e11d48;"></span>' : '') + '</div>' +
                (n.body ? '<div style="font-size:11px;color:#475569;margin-top:1px;">' + esc(n.body) + '</div>' : '') +
                (n.merchant_name ? '<div style="font-size:10px;color:#94a3b8;">' + esc(n.merchant_name) + '</div>' : '') +
                '<div style="font-size:10px;color:#cbd5e1;margin-top:2px;">' + esc(fmt(n.created_at)) + '</div>' +
                '</div></div>';
        }).join('');
        Array.prototype.forEach.call(list.querySelectorAll('.nb-item'), function (el) {
            el.addEventListener('click', function () {
                var id = el.getAttribute('data-id');
                api({ action: 'mark_notification_read', notification_id: id, user_id: UID });
                var it = notifs.find(function (x) { return x.id === id; }) || {};
                var mid = el.getAttribute('data-mid');
                // Deep-link straight to the exact note/task inside the merchant modal.
                if (mid) {
                    var q = 'merchants-dashboard.html?nm=' + encodeURIComponent(mid) +
                            '&nt=' + encodeURIComponent(it.type || '') +
                            '&nn=' + encodeURIComponent(it.note_id || '') +
                            '&ntk=' + encodeURIComponent(it.task_id || '');
                    location.href = q;
                } else {
                    if (it) it.is_read = true; renderBadge(); renderList();
                }
            });
        });
    }
    function load() {
        api({ action: 'get_my_notifications', user_id: UID }).then(function (r) {
            if (r && r.success) {
                var incoming = r.data || [];
                if (_primed) pushNew(incoming);
                incoming.forEach(function (n) { _knownIds[n.id] = true; });
                _primed = true;
                notifs = incoming; renderBadge();
                if (panel.style.display === 'block') renderList();
            }
        });
    }

    // Desktop push for genuinely-new unread notifications while the tab is hidden.
    function pushNew(incoming) {
        if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
        incoming.filter(function (n) { return !n.is_read && !_knownIds[n.id]; }).slice(0, 3).forEach(function (n) {
            try {
                var no = new Notification(n.title || 'New notification', { body: n.body || n.merchant_name || '', tag: String(n.id) });
                no.onclick = function () {
                    window.focus();
                    if (n.merchant_id) {
                        location.href = 'merchants-dashboard.html?nm=' + encodeURIComponent(n.merchant_id) +
                            '&nt=' + encodeURIComponent(n.type || '') + '&nn=' + encodeURIComponent(n.note_id || '') +
                            '&ntk=' + encodeURIComponent(n.task_id || '');
                    }
                    no.close();
                };
            } catch (e) { /* ignore */ }
        });
    }

    // Instant updates: subscribe to the dataless notification_pulse ping and
    // refetch (authenticated) whenever it fires. Falls back to polling.
    function initRealtime() {
        function connect() {
            if (!window.supabase || !window.supabase.createClient) return false;
            try {
                window.supabase.createClient(SB_URL, SB_ANON)
                    .channel('nb-pulse')
                    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'notification_pulse' }, function () { load(); })
                    .subscribe();
                return true;
            } catch (e) { return false; }
        }
        if (connect()) return;
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
        s.onload = connect;
        (document.head || document.body).appendChild(s);
    }

    btn.addEventListener('click', function () {
        var open = panel.style.display === 'block';
        panel.style.display = open ? 'none' : 'block';
        if (!open) {
            renderList(); load();   // show cached instantly, then pull fresh
            // Ask for desktop-alert permission on this user gesture (once).
            if ('Notification' in window && Notification.permission === 'default') {
                try { Notification.requestPermission(); } catch (e) {}
            }
        }
    });
    wrap.querySelector('#nb-markall').addEventListener('click', function () {
        api({ action: 'mark_notification_read', mark_all: true, user_id: UID }).then(function () {
            notifs.forEach(function (n) { n.is_read = true; }); renderBadge(); renderList();
        });
    });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) panel.style.display = 'none'; });

    load();
    initRealtime();             // instant updates via notification_pulse
    setInterval(load, 60000);   // safety-net poll (realtime does the heavy lifting)
    // Refresh immediately when the user returns to the tab/window.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
    window.addEventListener('focus', load);
})();

// Also load the floating staff messenger (idempotent via the #ppm-loader guard,
// so it's safe alongside the same loader in site-config.js). Covers pages that
// ship the bell but not site-config.js.
(function () {
    if (document.getElementById('ppm-loader')) return;
    var s = document.createElement('script');
    s.id = 'ppm-loader';
    s.src = '/js/messenger.js';
    (document.body || document.head).appendChild(s);
})();
