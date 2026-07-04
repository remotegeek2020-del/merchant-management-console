/*
 * Floating staff messenger — a self-contained, Facebook-style chat widget.
 * Launcher (bottom-right) → conversation list → pop-out chat windows that
 * dock along the bottom. Reuses the existing /api/chat backend (staff auth via
 * the site-config.js bearer injection; sender_id = pp_userid).
 *
 * Safe to include anywhere: no-ops without a staff session, skips itself on the
 * full-page chat (/chat.html) and on partner pages, and never throws if the API
 * is unavailable. Near-real-time via adaptive polling (fast when a chat is
 * focused, slower when idle, instant on focus/visibility/after send).
 */
(function () {
    'use strict';
    var TOKEN = localStorage.getItem('pp_session_token') || '';
    var UID = localStorage.getItem('pp_userid') || localStorage.getItem('userid') || '';
    if (!TOKEN || !UID) return;                                  // not a logged-in staff page
    var path = location.pathname;
    if (path.indexOf('/partner') === 0) return;                 // partner portal has its own messenger
    if (/\/chat(\.html)?$/.test(path)) return;                  // already on the full DM page
    if (document.getElementById('ppm-root')) return;            // already injected

    var MYNAME = (localStorage.getItem('pp_user_first_name') || '') + ' ' + (localStorage.getItem('pp_user_last_name') || '');
    MYNAME = MYNAME.trim() || 'Me';

    // ── state ──
    var listOpen = false;
    var windows = [];          // [{ id, name, user_type, online, minimized, el, lastRenderedIds }]
    var directory = [];        // last getUserList payload
    var unreadTotal = 0;
    var tickTimer = null;

    function api(body) {
        return fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
            body: JSON.stringify(Object.assign({ sender_id: UID }, body))
        }).then(function (r) { return r.json(); }).catch(function () { return { success: false }; });
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }
    function initials(n) { return (n || '?').split(' ').filter(Boolean).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase() || '?'; }
    function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

    // ── styles ──
    var css = document.createElement('style');
    css.textContent = [
        '#ppm-root{position:fixed;left:20px;bottom:20px;z-index:99990;font-family:system-ui,Segoe UI,Arial,sans-serif;}',
        '#ppm-launch{position:relative;width:54px;height:54px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#004990,#0369a1);color:#fff;box-shadow:0 6px 20px rgba(0,73,144,.4);display:flex;align-items:center;justify-content:center;transition:transform .15s;}',
        '#ppm-launch:hover{transform:scale(1.06);}',
        '#ppm-launch .material-icons{font-size:26px;}',
        '#ppm-badge{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;padding:0 5px;border-radius:11px;background:#e11d48;color:#fff;font-size:11px;font-weight:800;line-height:20px;text-align:center;border:2px solid #fff;display:none;}',
        '#ppm-list{position:fixed;left:20px;bottom:84px;width:330px;max-width:92vw;height:min(500px,70vh);background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;z-index:99990;}',
        '#ppm-list.open{display:flex;}',
        '.ppm-lhead{padding:14px 16px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between;}',
        '.ppm-lhead b{font-size:15px;color:#0f172a;}',
        '.ppm-search{margin:10px 12px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:13px;outline:none;}',
        '.ppm-search:focus{border-color:#0369a1;}',
        '.ppm-convs{flex:1;overflow-y:auto;}',
        '.ppm-conv{display:flex;gap:10px;padding:9px 14px;cursor:pointer;align-items:center;border-bottom:1px solid #f8fafc;}',
        '.ppm-conv:hover{background:#f8fafc;}',
        '.ppm-av{position:relative;width:40px;height:40px;border-radius:50%;background:#e0f2fe;color:#0369a1;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0;}',
        '.ppm-av.partner{background:#f0fdf4;color:#16a34a;}',
        '.ppm-dot{position:absolute;bottom:0;right:0;width:11px;height:11px;border-radius:50%;background:#22c55e;border:2px solid #fff;}',
        '.ppm-cbody{flex:1;min-width:0;}',
        '.ppm-cname{font-size:13px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:6px;}',
        '.ppm-tag{font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;background:#eef2ff;color:#4338ca;text-transform:uppercase;}',
        '.ppm-tag.partner{background:#f0fdf4;color:#166534;}',
        '.ppm-prev{font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.ppm-cunread{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e11d48;color:#fff;font-size:10px;font-weight:800;line-height:18px;text-align:center;flex-shrink:0;}',
        '.ppm-win{position:fixed;bottom:20px;width:320px;height:440px;max-height:72vh;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.24);display:flex;flex-direction:column;overflow:hidden;z-index:99989;}',
        '.ppm-win.min{height:46px;}',
        '.ppm-whead{background:linear-gradient(135deg,#002d5a,#004990);color:#fff;padding:10px 12px;display:flex;align-items:center;gap:9px;cursor:pointer;flex-shrink:0;}',
        '.ppm-whead .ppm-av{width:30px;height:30px;font-size:11px;background:rgba(255,255,255,.18);color:#fff;}',
        '.ppm-wname{flex:1;min-width:0;font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.ppm-wsub{font-size:10px;opacity:.75;font-weight:500;}',
        '.ppm-wbtn{background:none;border:none;color:#fff;cursor:pointer;padding:2px;display:flex;opacity:.85;}',
        '.ppm-wbtn:hover{opacity:1;}',
        '.ppm-wbtn .material-icons{font-size:18px;}',
        '.ppm-msgs{flex:1;overflow-y:auto;padding:12px 12px 6px;background:#f8fafc;display:flex;flex-direction:column;}',
        '.ppm-win.min .ppm-msgs,.ppm-win.min .ppm-input{display:none;}',
        '.ppm-row{display:flex;flex-direction:column;margin-top:2px;}',
        '.ppm-row.gap{margin-top:10px;}',
        '.ppm-row.me{align-items:flex-end;}',
        '.ppm-row.them{align-items:flex-start;}',
        '.ppm-b{max-width:80%;padding:7px 11px;border-radius:16px;font-size:12.5px;line-height:1.35;word-wrap:break-word;}',
        '.ppm-b.me{background:#0369a1;color:#fff;border-bottom-right-radius:5px;}',
        '.ppm-b.them{background:#fff;color:#0f172a;border:1px solid #e2e8f0;border-bottom-left-radius:5px;}',
        '.ppm-bt{font-size:9px;color:#b4bdc9;margin:2px 5px 0;display:none;}',
        '.ppm-row.showtime .ppm-bt{display:block;}',
        '.ppm-input{display:flex;gap:8px;padding:9px 10px;border-top:1px solid #f1f5f9;flex-shrink:0;align-items:flex-end;}',
        '.ppm-ta{flex:1;resize:none;border:1px solid #e2e8f0;border-radius:18px;padding:8px 12px;font-size:13px;max-height:90px;outline:none;font-family:inherit;}',
        '.ppm-ta:focus{border-color:#0369a1;}',
        '.ppm-send{width:36px;height:36px;border-radius:50%;border:none;background:#0369a1;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
        '.ppm-send:disabled{background:#cbd5e1;cursor:default;}',
        '.ppm-empty{text-align:center;color:#94a3b8;font-size:12px;padding:24px 16px;}',
        '@media(max-width:640px){.ppm-win{width:96vw;left:2vw!important;}#ppm-list{width:96vw;}}'
    ].join('');
    document.head.appendChild(css);

    // ── launcher + list shell ──
    var root = document.createElement('div');
    root.id = 'ppm-root';
    root.innerHTML =
        '<button id="ppm-launch" title="Messages"><span class="material-icons">chat_bubble</span>' +
        '<span id="ppm-badge"></span></button>';
    document.body.appendChild(root);

    var listEl = document.createElement('div');
    listEl.id = 'ppm-list';
    listEl.innerHTML =
        '<div class="ppm-lhead"><b>Messages</b>' +
        '<button class="ppm-wbtn" id="ppm-list-close" title="Close" style="color:#64748b;"><span class="material-icons">close</span></button></div>' +
        '<input class="ppm-search" id="ppm-search" placeholder="Search people…">' +
        '<div class="ppm-convs" id="ppm-convs"><div class="ppm-empty">Loading…</div></div>';
    document.body.appendChild(listEl);

    document.getElementById('ppm-launch').addEventListener('click', toggleList);
    document.getElementById('ppm-list-close').addEventListener('click', function () { setList(false); });
    document.getElementById('ppm-search').addEventListener('input', renderConvs);

    function toggleList() { setList(!listOpen); }
    function setList(open) {
        listOpen = open;
        listEl.classList.toggle('open', open);
        if (open) { refreshDirectory(); }
    }

    function setBadge(n) {
        unreadTotal = n;
        var b = document.getElementById('ppm-badge');
        b.style.display = n > 0 ? 'block' : 'none';
        b.textContent = n > 99 ? '99+' : String(n);
    }

    // ── directory / conversation list ──
    function refreshDirectory() {
        return api({ action: 'getUserList' }).then(function (r) {
            if (r && r.success) { directory = r.data || []; if (listOpen) renderConvs(); }
        });
    }
    function renderConvs() {
        var q = (document.getElementById('ppm-search').value || '').toLowerCase();
        var box = document.getElementById('ppm-convs');
        var items = directory.filter(function (u) { return !q || (u.name || '').toLowerCase().indexOf(q) !== -1; });
        if (!items.length) { box.innerHTML = '<div class="ppm-empty">No people found.</div>'; return; }
        box.innerHTML = items.map(function (u) {
            var isP = u.user_type === 'partner';
            return '<div class="ppm-conv" data-id="' + esc(u.id) + '" data-name="' + esc(u.name) + '" data-type="' + esc(u.user_type) + '" data-online="' + (u.is_online ? 1 : 0) + '">' +
                '<div class="ppm-av' + (isP ? ' partner' : '') + '">' + esc(initials(u.name)) +
                (u.is_online ? '<span class="ppm-dot"></span>' : '') + '</div>' +
                '<div class="ppm-cbody"><div class="ppm-cname">' + esc(u.name) +
                '<span class="ppm-tag' + (isP ? ' partner' : '') + '">' + (isP ? 'Partner' : 'Staff') + '</span></div>' +
                '<div class="ppm-prev">' + (u.last_message && u.last_message.preview ? esc(u.last_message.preview) : 'Start a conversation') + '</div></div>' +
                (u.unread > 0 ? '<div class="ppm-cunread">' + (u.unread > 99 ? '99+' : u.unread) + '</div>' : '') +
                '</div>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('.ppm-conv'), function (el) {
            el.addEventListener('click', function () {
                openWindow(el.getAttribute('data-id'), el.getAttribute('data-name'), el.getAttribute('data-type'), el.getAttribute('data-online') === '1');
                setList(false);
            });
        });
    }

    // ── chat windows ──
    function openWindow(id, name, type, online) {
        var existing = windows.find(function (w) { return w.id === id; });
        if (existing) { existing.minimized = false; existing.el.classList.remove('min'); relayout(); loadWindow(existing, true); focusInput(existing); return; }
        if (windows.length >= 3) { closeWindow(windows[0].id); }   // cap open windows

        var el = document.createElement('div');
        el.className = 'ppm-win';
        var isP = type === 'partner';
        el.innerHTML =
            '<div class="ppm-whead">' +
            '<div class="ppm-av' + (isP ? ' partner' : '') + '">' + esc(initials(name)) + '</div>' +
            '<div style="flex:1;min-width:0;"><div class="ppm-wname">' + esc(name) + '</div>' +
            '<div class="ppm-wsub">' + (online ? '● Online' : (isP ? 'Partner' : 'Staff')) + '</div></div>' +
            '<button class="ppm-wbtn ppm-min" title="Minimize"><span class="material-icons">remove</span></button>' +
            '<button class="ppm-wbtn ppm-close" title="Close"><span class="material-icons">close</span></button>' +
            '</div>' +
            '<div class="ppm-msgs"><div class="ppm-empty">Loading…</div></div>' +
            '<div class="ppm-input"><textarea class="ppm-ta" rows="1" placeholder="Aa"></textarea>' +
            '<button class="ppm-send" title="Send"><span class="material-icons" style="font-size:18px;">send</span></button></div>';
        document.body.appendChild(el);

        var win = { id: id, name: name, user_type: type, online: online, minimized: false, el: el, lastIds: '' };
        windows.push(win);

        el.querySelector('.ppm-whead').addEventListener('click', function (e) {
            if (e.target.closest('.ppm-min') || e.target.closest('.ppm-close')) return;
            win.minimized = !win.minimized; el.classList.toggle('min', win.minimized); relayout();
            if (!win.minimized) loadWindow(win, true);
        });
        el.querySelector('.ppm-min').addEventListener('click', function () { win.minimized = true; el.classList.add('min'); relayout(); });
        el.querySelector('.ppm-close').addEventListener('click', function () { closeWindow(id); });
        var ta = el.querySelector('.ppm-ta');
        var send = el.querySelector('.ppm-send');
        ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(win); } });
        ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 90) + 'px'; });
        send.addEventListener('click', function () { doSend(win); });
        el.addEventListener('mousedown', function () { win._focused = true; windows.forEach(function (w) { if (w !== win) w._focused = false; }); });

        relayout();
        loadWindow(win, true);
        focusInput(win);
    }

    function focusInput(win) { try { win.el.querySelector('.ppm-ta').focus(); } catch (e) {} win._focused = true; windows.forEach(function (w) { if (w !== win) w._focused = false; }); }

    function closeWindow(id) {
        var i = windows.findIndex(function (w) { return w.id === id; });
        if (i === -1) return;
        windows[i].el.remove();
        windows.splice(i, 1);
        relayout();
    }

    // Dock windows along the bottom, to the RIGHT of the launcher; rightward as
    // more open. (Launcher sits in the empty bottom-left corner.)
    function relayout() {
        var left = 90;    // clear the 54px launcher + margin
        windows.forEach(function (w) {
            w.el.style.left = left + 'px';
            w.el.style.right = 'auto';
            left += (w.minimized ? 210 : 320) + 12;
        });
    }

    function loadWindow(win, scroll) {
        return api({ action: 'getHistory', recipient_id: win.id, page: 0, limit: 50 }).then(function (r) {
            if (!r || !r.success) return;
            var msgs = r.data || [];
            var sig = msgs.map(function (m) { return m.id + (m.edited_at || '') + (m.deleted_at || ''); }).join(',');
            if (sig === win.lastIds && !scroll) return;   // nothing changed
            win.lastIds = sig;
            var box = win.el.querySelector('.ppm-msgs');
            if (!msgs.length) { box.innerHTML = '<div class="ppm-empty">No messages yet. Say hi 👋</div>'; return; }
            var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
            box.innerHTML = msgs.map(function (m, i) {
                var mine = String(m.sender_id) === String(UID);
                var prev = msgs[i - 1], next = msgs[i + 1];
                var newGroup = !prev || String(prev.sender_id) !== String(m.sender_id);
                // Show the time only on the last message of a same-sender run.
                var endGroup = !next || String(next.sender_id) !== String(m.sender_id);
                var body = m.deleted_at ? '<i style="opacity:.6;">message deleted</i>' : esc(m.content);
                return '<div class="ppm-row ' + (mine ? 'me' : 'them') + (newGroup ? ' gap' : '') + (endGroup ? ' showtime' : '') + '">' +
                    '<div class="ppm-b ' + (mine ? 'me' : 'them') + '">' + body + '</div>' +
                    '<div class="ppm-bt">' + fmtTime(m.created_at) + (m.edited_at ? ' · edited' : '') + '</div></div>';
            }).join('');
            if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
        });
    }

    function doSend(win) {
        var ta = win.el.querySelector('.ppm-ta');
        var text = (ta.value || '').trim();
        if (!text) return;
        ta.value = ''; ta.style.height = 'auto';
        api({ action: 'sendMessage', recipient_id: win.id, content: text, message_type: 'dm' }).then(function (r) {
            loadWindow(win, true);
        });
    }

    // ── polling tick (adaptive) ──
    var lastFast = 0;
    function tick() {
        if (document.hidden) return;
        // Badge + list refresh (also feeds previews/unread on list)
        api({ action: 'getUnreadCount' }).then(function (r) { if (r && r.success) setBadge(r.count || 0); });
        if (listOpen) refreshDirectory();
        // Refresh open, non-minimized windows
        windows.forEach(function (w) { if (!w.minimized) loadWindow(w, false); });
    }
    function startTicking() {
        if (tickTimer) clearInterval(tickTimer);
        // 3s cadence; the focused window feels near-instant, list/badge stay fresh.
        tickTimer = setInterval(tick, 3000);
    }

    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    window.addEventListener('focus', tick);

    // Public hook: open a DM programmatically, e.g. window.ppmOpen(id, name, 'staff')
    window.ppmOpen = function (id, name, type, online) { openWindow(String(id), name || 'Chat', type || 'staff', !!online); };

    // initial load
    api({ action: 'getUnreadCount' }).then(function (r) { if (r && r.success) setBadge(r.count || 0); });
    startTicking();
})();
