/*
 * Floating staff messenger — Facebook-style chat for the staff portal.
 * Launcher (bottom-left) → conversation list (Groups + People, search, New Group)
 * → pop-out chat windows (up to 4) that dock along the bottom. 1:1 DMs and group
 * chats. Near real-time via fast polling; buzz sound + desktop notification +
 * auto-popping chat heads on new incoming messages.
 *
 * Reuses /api/chat (staff auth via site-config.js bearer; sender_id = pp_userid).
 * Self-guards: no-ops without a staff session, and skips the full /chat page and
 * partner pages.
 */
(function () {
    'use strict';
    var TOKEN = localStorage.getItem('pp_session_token') || '';
    var UID = String(localStorage.getItem('pp_userid') || localStorage.getItem('userid') || '');
    if (!TOKEN || !UID) return;
    var path = location.pathname;
    if (path.indexOf('/partner') === 0) return;
    if (/\/chat(\.html)?$/.test(path)) return;
    if (document.getElementById('ppm-root')) return;

    var MAX_WINDOWS = 4;

    // ── state ──
    var listOpen = false, view = 'list';        // 'list' | 'newgroup'
    var windows = [];                            // [{ key, kind, id, name, type, minimized, el, lastSig }]
    var people = [], groups = [];
    var prevUnread = {};                         // key -> unread count (for new-message detection)
    var baselined = false;                       // skip buzz/pop on the very first poll
    var lastBuzz = 0, notifyAsked = false;

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
    function keyOf(kind, id) { return kind + ':' + id; }

    // ── buzz + desktop notification ──
    function buzz() {
        var now = Date.now();
        if (now - lastBuzz < 1500) return;       // throttle
        lastBuzz = now;
        try {
            var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
            var ctx = new C(), o = ctx.createOscillator(), g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination); o.type = 'sine'; o.frequency.value = 660;
            g.gain.setValueAtTime(0.0001, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
            o.start(); o.stop(ctx.currentTime + 0.3);
        } catch (e) {}
    }
    function desktopNotify(title, body) {
        try {
            if (!('Notification' in window) || Notification.permission !== 'granted') return;
            if (!document.hidden) return;         // only when tab is in the background
            var n = new Notification(title, { body: body || '', tag: 'ppm', renotify: true });
            n.onclick = function () { window.focus(); n.close(); };
        } catch (e) {}
    }

    // ── styles ──
    var css = document.createElement('style');
    css.textContent = [
        '@keyframes ppm-pulse{0%{box-shadow:0 6px 20px rgba(0,73,144,.4),0 0 0 0 rgba(225,29,72,.5);}70%{box-shadow:0 6px 20px rgba(0,73,144,.4),0 0 0 12px rgba(225,29,72,0);}100%{box-shadow:0 6px 20px rgba(0,73,144,.4),0 0 0 0 rgba(225,29,72,0);}}',
        '#ppm-root{position:fixed;left:20px;bottom:46px;z-index:99990;font-family:system-ui,Segoe UI,Arial,sans-serif;}',
        '#ppm-launch{position:relative;width:54px;height:54px;border-radius:50%;border:none;cursor:pointer;background:linear-gradient(135deg,#004990,#0369a1);color:#fff;box-shadow:0 6px 20px rgba(0,73,144,.4);display:flex;align-items:center;justify-content:center;transition:transform .15s;}',
        '#ppm-launch:hover{transform:scale(1.06);}',
        '#ppm-launch.alert{animation:ppm-pulse 1.6s infinite;}',
        '#ppm-launch .material-icons{font-size:26px;}',
        '#ppm-badge{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;padding:0 5px;border-radius:11px;background:#e11d48;color:#fff;font-size:11px;font-weight:800;line-height:20px;text-align:center;border:2px solid #fff;display:none;}',
        '#ppm-list{position:fixed;left:20px;bottom:172px;width:330px;max-width:92vw;height:min(440px,60vh);background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;z-index:99990;}',
        '#ppm-list.open{display:flex;}',
        '.ppm-lhead{padding:12px 14px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between;gap:8px;}',
        '.ppm-lhead b{font-size:15px;color:#0f172a;}',
        '.ppm-lhbtns{display:flex;gap:4px;}',
        '.ppm-ic{background:none;border:none;cursor:pointer;color:#64748b;padding:4px;border-radius:8px;display:flex;}',
        '.ppm-ic:hover{background:#f1f5f9;color:#0369a1;}',
        '.ppm-ic .material-icons{font-size:19px;}',
        '.ppm-search{margin:10px 12px;padding:8px 12px;border:1px solid #e2e8f0;border-radius:10px;font-size:13px;outline:none;}',
        '.ppm-search:focus{border-color:#0369a1;}',
        '.ppm-convs{flex:1;overflow-y:auto;}',
        '.ppm-sec{font-size:10px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;padding:8px 14px 3px;}',
        '.ppm-conv{display:flex;gap:10px;padding:9px 14px;cursor:pointer;align-items:center;border-bottom:1px solid #f8fafc;}',
        '.ppm-conv:hover{background:#f8fafc;}',
        '.ppm-av{position:relative;width:40px;height:40px;border-radius:50%;background:#e0f2fe;color:#0369a1;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;flex-shrink:0;}',
        '.ppm-av.partner{background:#f0fdf4;color:#16a34a;}',
        '.ppm-av.group{background:#eef2ff;color:#4338ca;}',
        '.ppm-dot{position:absolute;bottom:0;right:0;width:11px;height:11px;border-radius:50%;background:#22c55e;border:2px solid #fff;}',
        '.ppm-cbody{flex:1;min-width:0;}',
        '.ppm-cname{font-size:13px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:6px;}',
        '.ppm-tag{font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;background:#eef2ff;color:#4338ca;text-transform:uppercase;}',
        '.ppm-tag.partner{background:#f0fdf4;color:#166534;}',
        '.ppm-prev{font-size:11px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.ppm-cunread{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#e11d48;color:#fff;font-size:10px;font-weight:800;line-height:18px;text-align:center;flex-shrink:0;}',
        // new-group view
        '.ppm-ng{flex:1;display:flex;flex-direction:column;overflow:hidden;}',
        '.ppm-ngpick{flex:1;overflow-y:auto;}',
        '.ppm-pick{display:flex;gap:9px;padding:8px 14px;cursor:pointer;align-items:center;}',
        '.ppm-pick:hover{background:#f8fafc;}',
        '.ppm-pick input{width:16px;height:16px;accent-color:#0369a1;}',
        '.ppm-ngfoot{padding:10px 12px;border-top:1px solid #f1f5f9;display:flex;gap:8px;}',
        '.ppm-btn{flex:1;border:none;border-radius:9px;padding:9px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;}',
        '.ppm-btn.primary{background:#0369a1;color:#fff;}',
        '.ppm-btn.primary:disabled{background:#cbd5e1;cursor:default;}',
        '.ppm-btn.ghost{background:#f1f5f9;color:#475569;}',
        // windows
        '.ppm-win{position:fixed;bottom:46px;width:320px;height:440px;max-height:70vh;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.24);display:flex;flex-direction:column;overflow:hidden;z-index:99989;}',
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
        '.ppm-sname{font-size:10px;color:#64748b;font-weight:700;margin:0 0 1px 8px;}',
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

    // ── shell ──
    var root = document.createElement('div');
    root.id = 'ppm-root';
    root.innerHTML = '<button id="ppm-launch" title="Messages"><span class="material-icons">chat_bubble</span><span id="ppm-badge"></span></button>';
    document.body.appendChild(root);

    var listEl = document.createElement('div');
    listEl.id = 'ppm-list';
    document.body.appendChild(listEl);

    document.getElementById('ppm-launch').addEventListener('click', function () {
        if (!notifyAsked && 'Notification' in window && Notification.permission === 'default') { notifyAsked = true; try { Notification.requestPermission(); } catch (e) {} }
        setList(!listOpen);
    });

    function setList(open) {
        listOpen = open;
        listEl.classList.toggle('open', open);
        if (open) { view = 'list'; renderShell(); refreshLists(); }
    }
    function setBadge(n) {
        var b = document.getElementById('ppm-badge');
        b.style.display = n > 0 ? 'block' : 'none';
        b.textContent = n > 99 ? '99+' : String(n);
        document.getElementById('ppm-launch').classList.toggle('alert', n > 0);
    }

    // ── list vs new-group shell ──
    function renderShell() {
        if (view === 'newgroup') { renderNewGroup(); return; }
        listEl.innerHTML =
            '<div class="ppm-lhead"><b>Chats</b><div class="ppm-lhbtns">' +
            '<button class="ppm-ic" id="ppm-newgrp" title="New group"><span class="material-icons">group_add</span></button>' +
            '<button class="ppm-ic" id="ppm-close" title="Close"><span class="material-icons">close</span></button>' +
            '</div></div>' +
            '<input class="ppm-search" id="ppm-search" placeholder="Search…">' +
            '<div class="ppm-convs" id="ppm-convs"><div class="ppm-empty">Loading…</div></div>';
        document.getElementById('ppm-newgrp').addEventListener('click', function () { view = 'newgroup'; renderNewGroup(); });
        document.getElementById('ppm-close').addEventListener('click', function () { setList(false); });
        document.getElementById('ppm-search').addEventListener('input', renderConvs);
        renderConvs();
    }

    function renderConvs() {
        var box = document.getElementById('ppm-convs'); if (!box) return;
        var q = (document.getElementById('ppm-search') || {}).value || '';
        q = q.toLowerCase();
        var gs = groups.filter(function (g) { return !q || (g.name || '').toLowerCase().indexOf(q) !== -1; });
        var ps = people.filter(function (u) { return !q || (u.name || '').toLowerCase().indexOf(q) !== -1; });
        var html = '';
        if (gs.length) {
            html += '<div class="ppm-sec">Groups</div>' + gs.map(function (g) {
                return convRow('group', g.id, g.name, g.member_count + ' members', g.unread, g.last_message, false, 'group');
            }).join('');
        }
        html += '<div class="ppm-sec">People</div>';
        html += ps.length ? ps.map(function (u) {
            return convRow('dm', u.id, u.name, u.user_type === 'partner' ? 'Partner' : 'Staff', u.unread,
                u.last_message, u.is_online, u.user_type);
        }).join('') : '<div class="ppm-empty">No people found.</div>';
        box.innerHTML = html;
        Array.prototype.forEach.call(box.querySelectorAll('.ppm-conv'), function (el) {
            el.addEventListener('click', function () {
                openWindow(el.getAttribute('data-kind'), el.getAttribute('data-id'), el.getAttribute('data-name'), el.getAttribute('data-type'), el.getAttribute('data-online') === '1');
                setList(false);
            });
        });
    }

    function convRow(kind, id, name, sub, unread, last, online, avClass) {
        var isP = avClass === 'partner', isG = avClass === 'group';
        var av = isG ? '💬' : initials(name);
        return '<div class="ppm-conv" data-kind="' + kind + '" data-id="' + esc(id) + '" data-name="' + esc(name) + '" data-type="' + esc(isG ? 'group' : avClass) + '" data-online="' + (online ? 1 : 0) + '">' +
            '<div class="ppm-av ' + (isP ? 'partner' : isG ? 'group' : '') + '">' + (isG ? '<span class="material-icons" style="font-size:20px;">groups</span>' : esc(av)) +
            (online ? '<span class="ppm-dot"></span>' : '') + '</div>' +
            '<div class="ppm-cbody"><div class="ppm-cname">' + esc(name) +
            (isG ? '' : '<span class="ppm-tag' + (isP ? ' partner' : '') + '">' + esc(sub) + '</span>') + '</div>' +
            '<div class="ppm-prev">' + (last && last.preview ? esc(last.preview) : (isG ? esc(sub) : 'Start a conversation')) + '</div></div>' +
            (unread > 0 ? '<div class="ppm-cunread">' + (unread > 99 ? '99+' : unread) + '</div>' : '') +
            '</div>';
    }

    // ── new group ──
    function renderNewGroup() {
        var rows = people.map(function (u) {
            return '<label class="ppm-pick"><input type="checkbox" value="' + esc(u.id) + '" data-type="' + esc(u.user_type) + '" data-name="' + esc(u.name) + '">' +
                '<div class="ppm-av ' + (u.user_type === 'partner' ? 'partner' : '') + '" style="width:30px;height:30px;font-size:11px;">' + esc(initials(u.name)) + '</div>' +
                '<div style="flex:1;min-width:0;"><div class="ppm-cname">' + esc(u.name) + '</div></div></label>';
        }).join('') || '<div class="ppm-empty">No people to add.</div>';
        listEl.innerHTML =
            '<div class="ppm-lhead"><b>New group</b><button class="ppm-ic" id="ppm-ng-back" title="Back"><span class="material-icons">arrow_back</span></button></div>' +
            '<input class="ppm-search" id="ppm-ng-name" placeholder="Group name…">' +
            '<div class="ppm-ng"><div class="ppm-ngpick" id="ppm-ng-pick">' + rows + '</div>' +
            '<div class="ppm-ngfoot"><button class="ppm-btn ghost" id="ppm-ng-cancel">Cancel</button>' +
            '<button class="ppm-btn primary" id="ppm-ng-create">Create</button></div></div>';
        document.getElementById('ppm-ng-back').addEventListener('click', function () { view = 'list'; renderShell(); });
        document.getElementById('ppm-ng-cancel').addEventListener('click', function () { view = 'list'; renderShell(); });
        document.getElementById('ppm-ng-create').addEventListener('click', createGroup);
    }
    function createGroup() {
        var name = (document.getElementById('ppm-ng-name').value || '').trim();
        var picks = Array.prototype.slice.call(document.querySelectorAll('#ppm-ng-pick input:checked'));
        if (!name) { document.getElementById('ppm-ng-name').focus(); return; }
        if (!picks.length) return;
        var members = picks.map(function (c) { return { id: c.value, type: c.getAttribute('data-type') }; });
        var btn = document.getElementById('ppm-ng-create'); btn.disabled = true; btn.textContent = 'Creating…';
        api({ action: 'createGroup', name: name, members: members }).then(function (r) {
            if (r && r.success && r.group) {
                view = 'list';
                refreshLists().then(function () { setList(false); openWindow('group', r.group.id, r.group.name, 'group', false); });
            } else { btn.disabled = false; btn.textContent = 'Create'; }
        });
    }

    // ── directory + groups refresh (also badge + new-message detection) ──
    function refreshLists() {
        return Promise.all([api({ action: 'getUserList' }), api({ action: 'getGroups' })]).then(function (res) {
            var ul = res[0], gl = res[1];
            if (ul && ul.success) people = ul.data || [];
            if (gl && gl.success) groups = gl.data || [];

            var total = 0, cur = {};
            people.forEach(function (u) { total += u.unread || 0; cur[keyOf('dm', u.id)] = { unread: u.unread || 0, name: u.name, kind: 'dm', id: u.id, type: u.user_type, last: u.last_message }; });
            groups.forEach(function (g) { total += g.unread || 0; cur[keyOf('group', g.id)] = { unread: g.unread || 0, name: g.name, kind: 'group', id: g.id, type: 'group', last: g.last_message }; });
            setBadge(total);
            detectNew(cur);
            prevUnread = {}; Object.keys(cur).forEach(function (k) { prevUnread[k] = cur[k].unread; });
            if (listOpen && view === 'list') renderConvs();
        });
    }

    // Buzz / notify / auto-pop a chat head when unread rises for a conversation.
    function detectNew(cur) {
        if (!baselined) { baselined = true; return; }   // first poll = baseline, no alerts
        var alerted = false;
        Object.keys(cur).forEach(function (k) {
            var c = cur[k], was = prevUnread[k] || 0;
            if (c.unread > was && c.unread > 0) {
                var win = windows.find(function (w) { return w.key === k; });
                var openFocused = win && !win.minimized && win._focused && !document.hidden;
                if (!openFocused) {
                    alerted = true;
                    if (!win) openWindow(c.kind, c.id, c.name, c.type, false, true);   // auto-pop minimized
                    desktopNotify(c.name, c.last && c.last.preview ? String(c.last.preview).slice(0, 90) : 'New message');
                }
            }
        });
        if (alerted) buzz();
    }

    // ── chat windows ──
    function openWindow(kind, id, name, type, online, popMinimized) {
        var key = keyOf(kind, id);
        var existing = windows.find(function (w) { return w.key === key; });
        if (existing) { existing.minimized = false; existing.el.classList.remove('min'); relayout(); loadWindow(existing, true); focusInput(existing); return; }
        if (windows.length >= MAX_WINDOWS) { closeWindow(windows[0].key); }

        var isG = kind === 'group', isP = type === 'partner';
        var el = document.createElement('div');
        el.className = 'ppm-win' + (popMinimized ? ' min' : '');
        el.innerHTML =
            '<div class="ppm-whead">' +
            '<div class="ppm-av ' + (isP ? 'partner' : isG ? 'group' : '') + '">' + (isG ? '<span class="material-icons" style="font-size:17px;">groups</span>' : esc(initials(name))) + '</div>' +
            '<div style="flex:1;min-width:0;"><div class="ppm-wname">' + esc(name) + '</div>' +
            '<div class="ppm-wsub">' + (isG ? 'Group' : (online ? '● Online' : (isP ? 'Partner' : 'Staff'))) + '</div></div>' +
            '<button class="ppm-wbtn ppm-min" title="Minimize"><span class="material-icons">remove</span></button>' +
            '<button class="ppm-wbtn ppm-close" title="Close"><span class="material-icons">close</span></button></div>' +
            '<div class="ppm-msgs"><div class="ppm-empty">Loading…</div></div>' +
            '<div class="ppm-input"><textarea class="ppm-ta" rows="1" placeholder="Aa"></textarea>' +
            '<button class="ppm-send" title="Send"><span class="material-icons" style="font-size:18px;">send</span></button></div>';
        document.body.appendChild(el);

        var win = { key: key, kind: kind, id: id, name: name, type: type, minimized: !!popMinimized, el: el, lastSig: '' };
        windows.push(win);

        el.querySelector('.ppm-whead').addEventListener('click', function (e) {
            if (e.target.closest('.ppm-min') || e.target.closest('.ppm-close')) return;
            win.minimized = !win.minimized; el.classList.toggle('min', win.minimized); relayout();
            if (!win.minimized) { loadWindow(win, true); focusInput(win); }
        });
        el.querySelector('.ppm-min').addEventListener('click', function () { win.minimized = true; el.classList.add('min'); relayout(); });
        el.querySelector('.ppm-close').addEventListener('click', function () { closeWindow(key); });
        var ta = el.querySelector('.ppm-ta');
        ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(win); } });
        ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 90) + 'px'; });
        el.querySelector('.ppm-send').addEventListener('click', function () { doSend(win); });
        el.addEventListener('mousedown', function () { windows.forEach(function (w) { w._focused = (w === win); }); });

        relayout();
        loadWindow(win, true);
        if (!popMinimized) focusInput(win);
    }
    function focusInput(win) { try { win.el.querySelector('.ppm-ta').focus(); } catch (e) {} windows.forEach(function (w) { w._focused = (w === win); }); }
    function closeWindow(key) {
        var i = windows.findIndex(function (w) { return w.key === key; });
        if (i === -1) return;
        windows[i].el.remove(); windows.splice(i, 1); relayout();
    }
    function relayout() {
        var left = 150;   // clear the launcher + "Report a Bug" pill width
        windows.forEach(function (w) {
            w.el.style.left = left + 'px'; w.el.style.right = 'auto';
            left += (w.minimized ? 210 : 320) + 12;
        });
    }

    function loadWindow(win, scroll) {
        var act = win.kind === 'group' ? 'getGroupHistory' : 'getHistory';
        var body = win.kind === 'group' ? { action: act, group_id: win.id, page: 0, limit: 50 } : { action: act, recipient_id: win.id, page: 0, limit: 50 };
        return api(body).then(function (r) {
            if (!r || !r.success) return;
            var msgs = r.data || [];
            var sig = msgs.map(function (m) { return m.id + (m.edited_at || '') + (m.deleted_at || ''); }).join(',');
            var changed = sig !== win.lastSig;
            // Soft buzz when a new message arrives inside an open window from someone else.
            if (changed && win.lastSig && msgs.length) {
                var last = msgs[msgs.length - 1];
                if (String(last.sender_id) !== UID && (!win._focused || document.hidden)) buzz();
            }
            if (!changed && !scroll) return;
            win.lastSig = sig;
            var box = win.el.querySelector('.ppm-msgs');
            if (!msgs.length) { box.innerHTML = '<div class="ppm-empty">No messages yet. Say hi 👋</div>'; return; }
            var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
            box.innerHTML = msgs.map(function (m, i) {
                var mine = String(m.sender_id) === UID;
                var prev = msgs[i - 1], next = msgs[i + 1];
                var newGroup = !prev || String(prev.sender_id) !== String(m.sender_id);
                var endGroup = !next || String(next.sender_id) !== String(m.sender_id);
                var body = m.deleted_at ? '<i style="opacity:.6;">message deleted</i>' : esc(m.content);
                var nameLbl = (win.kind === 'group' && !mine && newGroup && m.sender_name) ? '<div class="ppm-sname">' + esc(m.sender_name) + '</div>' : '';
                return '<div class="ppm-row ' + (mine ? 'me' : 'them') + (newGroup ? ' gap' : '') + (endGroup ? ' showtime' : '') + '">' +
                    nameLbl + '<div class="ppm-b ' + (mine ? 'me' : 'them') + '">' + body + '</div>' +
                    '<div class="ppm-bt">' + fmtTime(m.created_at) + (m.edited_at ? ' · edited' : '') + '</div></div>';
            }).join('');
            if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
        });
    }

    function doSend(win) {
        var ta = win.el.querySelector('.ppm-ta');
        var text = (ta.value || '').trim(); if (!text) return;
        ta.value = ''; ta.style.height = 'auto';
        var body = win.kind === 'group'
            ? { action: 'sendGroupMessage', group_id: win.id, content: text }
            : { action: 'sendMessage', recipient_id: win.id, content: text, message_type: 'dm' };
        api(body).then(function () { loadWindow(win, true); });
    }

    // ── polling ──
    var tickTimer = null;
    function tick() {
        if (document.hidden) return;
        refreshLists();
        windows.forEach(function (w) { if (!w.minimized) loadWindow(w, false); });
    }
    function startTicking() { if (tickTimer) clearInterval(tickTimer); tickTimer = setInterval(tick, 2500); }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    window.addEventListener('focus', tick);

    // Public hook: window.ppmOpen(id, name, 'staff'|'partner')
    window.ppmOpen = function (id, name, type, online) { openWindow('dm', String(id), name || 'Chat', type || 'staff', !!online); };

    refreshLists();
    startTicking();
})();
