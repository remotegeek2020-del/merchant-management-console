/*
 * Shared JARVIS widget — drop-in floating assistant for staff dashboards.
 * Include AFTER the page's main scripts: <script src="/js/jarvis-widget.js"></script>
 *
 * - Access-gated: only shows for super_admins or users with pp_access_jarvis.
 * - Self-contained (own DOM/CSS/handlers, jw* namespaced) so it never clashes with
 *   the inline widget on index.html (it no-ops if that one is present).
 * - Memory: restores the recent conversation from the server on first open.
 * - Operator: renders the Confirm/Cancel card for proposed actions.
 */
(function () {
    var role = localStorage.getItem('pp_role') || '';
    var allowed = role === 'super_admin' || localStorage.getItem('pp_access_jarvis') === 'true';
    if (!allowed) return;
    // index.html ships its own inline Jarvis — don't double up there.
    if (document.getElementById('jarvis-trigger') || document.getElementById('jarvis-sidebar')) return;

    var token = function () { return localStorage.getItem('pp_session_token') || ''; };
    var userId = function () { return localStorage.getItem('pp_userid') || ''; };
    var userName = function () { return localStorage.getItem('pp_user_first_name') || localStorage.getItem('pp_first_name') || 'Sir'; };
    var _last = '';
    var _historyLoaded = false;
    window._jwPending = null;

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }
    function md(t) {
        return esc(t)
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/^- (.*)$/gm, '• $1')
            .replace(/\n/g, '<br>');
    }

    var css = ''
        + '#jw-fab{position:fixed;bottom:22px;right:22px;z-index:9998;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#001e3c,#0369a1);color:#fff;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(3,105,161,.45);display:flex;align-items:center;justify-content:center;transition:transform .15s;}'
        + '#jw-fab:hover{transform:scale(1.06);}'
        + '#jw-panel{position:fixed;bottom:88px;right:22px;z-index:9999;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 130px);background:#0b1526;border:1px solid #1e3a5f;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);display:none;flex-direction:column;overflow:hidden;font-family:"DM Sans",system-ui,sans-serif;}'
        + '#jw-panel.open{display:flex;}'
        + '.jw-head{background:linear-gradient(135deg,#001e3c,#0f3460);color:#fff;padding:13px 16px;display:flex;align-items:center;gap:9px;}'
        + '.jw-head b{font-size:13px;font-weight:800;letter-spacing:1px;flex:1;}'
        + '.jw-head .jw-x{background:none;border:none;color:#9fb3d1;cursor:pointer;display:flex;}'
        + '.jw-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;}'
        + '.jw-body{flex:1;overflow-y:auto;padding:14px;background:#0b1526;}'
        + '.jw-body::-webkit-scrollbar{width:6px;}.jw-body::-webkit-scrollbar-thumb{background:#1e3a5f;border-radius:3px;}'
        + '.jw-msg-u{text-align:right;margin-bottom:10px;}'
        + '.jw-msg-u span{display:inline-block;background:#0369a1;color:#fff;border-radius:12px 12px 2px 12px;padding:8px 13px;font-size:13px;max-width:90%;text-align:left;}'
        + '.jw-msg-a{background:#0f2036;border:1px solid #1e3a5f;color:#dbe7f5;border-radius:12px 12px 12px 2px;padding:10px 13px;font-size:13px;line-height:1.55;margin-bottom:10px;max-width:95%;}'
        + '.jw-tag{display:inline-flex;align-items:center;gap:4px;background:#0f2744;border:1px solid #1e3a5f;color:#7dd3fc;border-radius:99px;padding:2px 9px;font-size:10px;font-weight:700;margin:0 3px 6px 0;}'
        + '.jw-btn{display:inline-flex;align-items:center;gap:5px;background:#0369a1;color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:11px;font-weight:700;cursor:pointer;margin:3px 3px 0 0;font-family:inherit;}'
        + '.jw-foot{padding:11px;border-top:1px solid #1e3a5f;display:flex;gap:8px;background:#0b1526;}'
        + '.jw-foot input{flex:1;background:#0f2036;border:1px solid #1e3a5f;border-radius:10px;padding:10px 13px;color:#fff;font-size:13px;outline:none;font-family:inherit;}'
        + '.jw-foot input:focus{border-color:#0369a1;}'
        + '.jw-send{background:#0369a1;border:none;border-radius:10px;color:#fff;width:42px;cursor:pointer;display:flex;align-items:center;justify-content:center;}'
        + '.jw-pending{margin-top:10px;border:1px solid #f59e0b;background:rgba(245,158,11,.10);border-radius:10px;padding:11px;}'
        + '@keyframes jwspin{to{transform:rotate(360deg);}}';

    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

    var wrap = document.createElement('div');
    wrap.innerHTML = ''
        + '<button id="jw-fab" title="Ask Jarvis"><span class="material-icons">smart_toy</span></button>'
        + '<div id="jw-panel">'
        + '  <div class="jw-head"><span class="jw-dot"></span><b>JARVIS</b><button class="jw-x" onclick="jwToggle()"><span class="material-icons" style="font-size:18px;">close</span></button></div>'
        + '  <div class="jw-body" id="jw-body"><div class="jw-msg-a">Hello — I\'m JARVIS. Ask me about merchants, partners, prospects, deployments, or tell me to assign a rep, award a certificate, or update a ticket.</div></div>'
        + '  <div class="jw-foot"><input id="jw-input" type="text" placeholder="Ask Jarvis anything..." onkeydown="if(event.key===\'Enter\')jwAsk()"><button class="jw-send" onclick="jwAsk()"><span class="material-icons" style="font-size:18px;">send</span></button></div>'
        + '</div>';
    document.body.appendChild(wrap);
    document.getElementById('jw-fab').addEventListener('click', jwToggle);

    function scrollDown() { var b = document.getElementById('jw-body'); b.scrollTop = b.scrollHeight; }

    window.jwToggle = function () {
        var p = document.getElementById('jw-panel');
        var open = !p.classList.contains('open');
        p.classList.toggle('open', open);
        if (open && !_historyLoaded) { _historyLoaded = true; jwLoadHistory(); }
        if (open) setTimeout(function () { var i = document.getElementById('jw-input'); if (i) i.focus(); }, 50);
    };

    async function jwLoadHistory() {
        try {
            var res = await fetch('/api/oracle-agent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() }, body: JSON.stringify({ mode: 'history', userId: userId() }) });
            var d = await res.json();
            var hist = (d && d.history) || [];
            if (!hist.length) return;
            var body = document.getElementById('jw-body');
            body.innerHTML = ''; // replace greeting with restored conversation
            hist.forEach(function (m) {
                if (m.role === 'user') body.innerHTML += '<div class="jw-msg-u"><span>' + esc(m.content) + '</span></div>';
                else { body.innerHTML += '<div class="jw-msg-a">' + md(m.content) + '</div>'; _last = m.content; }
            });
            body.innerHTML += '<div style="text-align:center;color:#3b5578;font-size:10px;margin:6px 0 10px;">— restored your recent conversation —</div>';
            scrollDown();
        } catch (e) { /* ignore */ }
    }

    window.jwAsk = async function () {
        var input = document.getElementById('jw-input');
        var q = (input.value || '').trim();
        if (!q) return;
        var body = document.getElementById('jw-body');
        input.value = ''; input.disabled = true;
        body.innerHTML += '<div class="jw-msg-u"><span>' + esc(q) + '</span></div>';
        var lid = 'jw-' + Date.now();
        body.innerHTML += '<div class="jw-msg-a" id="' + lid + '"><span class="material-icons" style="font-size:14px;vertical-align:-2px;animation:jwspin 1s linear infinite;">sync</span> Consulting data systems...</div>';
        scrollDown();
        try {
            var res = await fetch('/api/oracle-agent', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() },
                body: JSON.stringify({ query: q, lastResponse: _last, userId: userId(), userName: userName() })
            });
            var d = await res.json();
            var el = document.getElementById(lid);
            var html = '';
            if (d.tools_used && d.tools_used.length) { d.tools_used.forEach(function (t) { html += '<span class="jw-tag"><span class="material-icons" style="font-size:10px;">database</span>' + esc(t) + '</span>'; }); html += '<br>'; }
            html += md(d.answer || 'No response.');
            if (d.suggestions && d.suggestions.length) {
                d.suggestions.forEach(function (s) { html += '<button class="jw-btn" onclick="window.location.href=\'' + esc(s.url) + '\'"><span class="material-icons" style="font-size:12px;">open_in_new</span>' + esc(s.label) + '</button>'; });
            }
            if (d.pending_action && d.pending_action.name) {
                window._jwPending = d.pending_action;
                var dz = !!d.pending_action.dangerous;
                var accent = dz ? '#ef4444' : '#f59e0b';
                html += '<div class="jw-pending" style="border-color:' + accent + ';background:' + (dz ? 'rgba(239,68,68,.10)' : 'rgba(245,158,11,.10)') + ';">'
                    + '<div style="font-size:10px;font-weight:800;color:' + accent + ';letter-spacing:.5px;margin-bottom:6px;text-transform:uppercase;"><span class="material-icons" style="font-size:12px;vertical-align:-2px;">' + (dz ? 'warning' : 'bolt') + '</span> ' + (dz ? 'Destructive action' : 'Action — confirm to run') + '</div>'
                    + '<div style="font-size:13px;color:#e2e8f0;margin-bottom:9px;">' + esc(d.pending_action.label || '') + '</div>'
                    + (dz ? '<input id="jw-confirm-text" type="text" placeholder="Type CONFIRM" autocomplete="off" style="width:100%;margin-bottom:8px;background:#0b1526;border:1px solid ' + accent + ';border-radius:8px;padding:8px 11px;color:#fff;font-size:13px;outline:none;">' : '')
                    + '<button class="jw-btn" style="background:' + (dz ? '#ef4444' : '#0d9488') + ';" onclick="jwConfirm(this)"><span class="material-icons" style="font-size:12px;">check</span>' + (dz ? 'Delete' : 'Confirm') + '</button>'
                    + '<button class="jw-btn" style="background:#334155;" onclick="jwCancel(this)"><span class="material-icons" style="font-size:12px;">close</span>Cancel</button>'
                    + '<span id="jw-confirm-msg" style="font-size:11px;color:#ef4444;margin-left:6px;"></span></div>';
            }
            el.innerHTML = html;
            _last = d.answer || '';
        } catch (e) {
            var el2 = document.getElementById(lid); if (el2) el2.innerHTML = '<span style="color:#ef4444;">Connection error. Please try again.</span>';
        }
        input.disabled = false; input.focus(); scrollDown();
    };

    window.jwConfirm = async function (btn) {
        var pa = window._jwPending; if (!pa) return;
        var confirmText = '';
        if (pa.dangerous) {
            var inp = document.getElementById('jw-confirm-text');
            confirmText = inp ? inp.value : '';
            if (String(confirmText).trim().toUpperCase() !== 'CONFIRM') { var msg = document.getElementById('jw-confirm-msg'); if (msg) msg.textContent = 'Type CONFIRM to proceed.'; return; }
        }
        var wrapEl = btn.closest('.jw-pending');
        if (wrapEl) wrapEl.innerHTML = '<div style="font-size:12px;color:#7dd3fc;"><span class="material-icons" style="font-size:13px;vertical-align:-2px;animation:jwspin 1s linear infinite;">sync</span> Running…</div>';
        try {
            var res = await fetch('/api/oracle-agent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() }, body: JSON.stringify({ execute_action: { name: pa.name, args: pa.args, confirm_text: confirmText } }) });
            var d = await res.json();
            if (wrapEl) wrapEl.innerHTML = '<div style="font-size:13px;color:' + (d.executed ? '#22c55e' : '#ef4444') + ';">' + md(d.answer || '') + '</div>';
        } catch (e) { if (wrapEl) wrapEl.innerHTML = '<div style="font-size:13px;color:#ef4444;">Connection error — action not run.</div>'; }
        window._jwPending = null; scrollDown();
    };
    window.jwCancel = function (btn) {
        var wrapEl = btn.closest('.jw-pending'); if (wrapEl) wrapEl.innerHTML = '<div style="font-size:12px;color:#94a3b8;">Action cancelled.</div>';
        window._jwPending = null;
    };
})();
