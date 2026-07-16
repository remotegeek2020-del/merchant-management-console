/*
 * Terminal Types — self-serve manager for trained equipment staff (no Secret
 * Dungeon needed). Shows a floating side button ONLY when the logged-in staff
 * has the granular `access_terminal_types` flag (admins/super always). Lets them
 * add / rename / merge / activate / delete terminal types. Every change goes
 * through the gated API (2-step confirm), is written to activity logs, and emails
 * the web developer. Include with: <script src="/terminal-access.js"></script>
 */
(function () {
    'use strict';
    var token = localStorage.getItem('pp_session_token') || '';
    if (!token) return;

    function roleIsAdmin(role) {
        role = (role || '').toLowerCase();
        return role.indexOf('super') !== -1 || role.indexOf('admin') !== -1;
    }

    // Gate: build the UI only if the staff member has terminal-type access.
    // localStorage (mirrored at login) is the fast path, but it lives only on
    // pages that load js/script.js — so if it doesn't already grant access we
    // authoritatively re-check with the server (validate) and refresh the flag.
    // This makes a freshly-granted flag work WITHOUT a re-login.
    var lsRole = (localStorage.getItem('pp_role') || '').toLowerCase();
    if (roleIsAdmin(lsRole) || localStorage.getItem('pp_access_terminal_types') === 'true') {
        build();
    } else {
        fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ action: 'validate' })
        }).then(function (r) { return r.json(); }).then(function (res) {
            var u = res && res.user ? res.user : res;
            if (!u) return;
            var granted = roleIsAdmin(u.role) || u.access_terminal_types === true;
            // Keep localStorage in sync so subsequent loads use the fast path.
            try { localStorage.setItem('pp_access_terminal_types', granted ? 'true' : 'false'); } catch (e) {}
            if (granted) build();
        }).catch(function () {});
    }

    function build() {
    if (document.getElementById('tta-fab')) return;

    function esc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
    function api(body) {
        return fetch('/api/equipments', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(body) }).then(function (r) { return r.json(); });
    }

    var style = document.createElement('style');
    style.textContent = [
        '#tta-fab{position:fixed;top:calc(50% + 96px);right:0;transform:translateY(-50%);z-index:99998;writing-mode:vertical-rl;background:rgba(13,148,136,.85);color:#fff;border:none;border-radius:8px 0 0 8px;padding:12px 5px;font-size:10px;font-weight:700;cursor:pointer;box-shadow:-2px 2px 8px rgba(13,148,136,.25);opacity:.6;letter-spacing:.4px;font-family:Inter,Arial,sans-serif;}',
        '#tta-fab:hover{opacity:1;padding-right:8px;}',
        '#tta-ov{display:none;position:fixed;inset:0;z-index:99999;background:rgba(2,10,25,.55);align-items:flex-start;justify-content:center;padding:26px 14px;overflow:auto;font-family:Inter,Arial,sans-serif;}',
        '#tta-ov.open{display:flex;}',
        '.tta-box{background:#fff;border-radius:16px;width:100%;max-width:640px;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden;}',
        '.tta-head{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid #e2e8f0;background:linear-gradient(135deg,#0f766e,#0d9488);color:#fff;}',
        '.tta-head b{flex:1;font-size:16px;}',
        '.tta-x{cursor:pointer;font-size:20px;line-height:1;background:none;border:none;color:#fff;}',
        '.tta-body{padding:16px 20px 22px;max-height:72vh;overflow:auto;}',
        '.tta-inp{width:100%;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:9px;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box;}',
        '.tta-inp:focus{border-color:#0d9488;}',
        '.tta-btn{border:none;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;}',
        '.tta-primary{background:#0d9488;color:#fff;}',
        '.tta-ghost{background:#fff;color:#475569;border:1px solid #e2e8f0;}',
        '.tta-danger{background:#fff;color:#dc2626;border:1px solid #fecaca;}',
        '.tta-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;}',
        '.tta-row .nm{flex:1;font-weight:700;color:#0a1628;}',
        '.tta-row .ct{font-size:11px;color:#94a3b8;font-weight:700;}',
        '.tta-off{opacity:.5;}',
        '.tta-note{font-size:11px;color:#94a3b8;margin:2px 0 12px;}',
        '#tta-confirm{position:fixed;inset:0;z-index:100000;background:rgba(2,10,25,.6);display:none;align-items:center;justify-content:center;padding:20px;font-family:Inter,Arial,sans-serif;}',
        '#tta-confirm.open{display:flex;}',
        '.tta-cbox{background:#fff;border-radius:14px;max-width:420px;width:100%;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.35);}',
        '.tta-cbox h3{margin:0 0 10px;font-size:16px;color:#0a1628;}',
        '.tta-ack{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:#475569;margin:14px 0;cursor:pointer;}'
    ].join('');
    document.head.appendChild(style);

    var fab = document.createElement('button');
    fab.id = 'tta-fab';
    fab.innerHTML = '🖥️ Terminal Types';
    document.body.appendChild(fab);

    var ov = document.createElement('div');
    ov.id = 'tta-ov';
    ov.innerHTML =
        '<div class="tta-box">' +
          '<div class="tta-head"><span class="material-icons" style="font-size:20px;">memory</span><b>Terminal Types</b><button class="tta-x" id="tta-close">✕</button></div>' +
          '<div class="tta-body">' +
            '<div style="display:flex;gap:8px;margin-bottom:6px;">' +
              '<input class="tta-inp" id="tta-new" placeholder="New terminal type name…">' +
              '<button class="tta-btn tta-primary" id="tta-add" style="white-space:nowrap;">+ Add</button>' +
            '</div>' +
            '<div class="tta-note">Every change is logged and emails the web developer. Renames &amp; merges move all affected units automatically.</div>' +
            '<input class="tta-inp" id="tta-search" placeholder="Search types…" style="margin-bottom:10px;">' +
            '<div id="tta-list"><div style="color:#94a3b8;text-align:center;padding:16px;">Loading…</div></div>' +
          '</div>' +
        '</div>';
    document.body.appendChild(ov);

    var confirmEl = document.createElement('div');
    confirmEl.id = 'tta-confirm';
    document.body.appendChild(confirmEl);

    var TYPES = [];      // [{id, name, is_active}]
    var COUNTS = {};     // name -> unit count

    fab.addEventListener('click', function () { ov.classList.add('open'); load(); });
    document.getElementById('tta-close').addEventListener('click', function () { ov.classList.remove('open'); });
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('open'); });
    document.getElementById('tta-search').addEventListener('input', render);
    document.getElementById('tta-add').addEventListener('click', addType);

    function load() {
        Promise.all([api({ action: 'list_terminal_types' }), api({ action: 'get_terminal_types' })]).then(function (res) {
            TYPES = (res[0] && res[0].terminal_types) || [];
            COUNTS = {}; ((res[1] && res[1].data) || []).forEach(function (t) { COUNTS[t.type] = t.count; });
            render();
        }).catch(function () { document.getElementById('tta-list').innerHTML = '<div style="color:#dc2626;padding:16px;">Failed to load.</div>'; });
    }

    function render() {
        var q = (document.getElementById('tta-search').value || '').toLowerCase().trim();
        var rows = TYPES.filter(function (t) { return !q || String(t.name).toLowerCase().indexOf(q) !== -1; })
            .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
            .map(function (t) {
                var c = COUNTS[t.name] || 0;
                return '<div class="tta-row ' + (t.is_active ? '' : 'tta-off') + '">' +
                    '<span class="nm">' + esc(t.name) + (t.is_active ? '' : ' <span class="ct">(inactive)</span>') + '</span>' +
                    '<span class="ct">' + c + ' unit' + (c !== 1 ? 's' : '') + '</span>' +
                    '<button class="tta-btn tta-ghost" onclick="__ttaRename(\'' + t.id + '\')">Rename</button>' +
                    '<button class="tta-btn tta-ghost" onclick="__ttaMerge(\'' + t.id + '\')">Merge</button>' +
                    '<button class="tta-btn tta-ghost" onclick="__ttaToggle(\'' + t.id + '\')">' + (t.is_active ? 'Disable' : 'Enable') + '</button>' +
                    '<button class="tta-btn tta-danger" onclick="__ttaDelete(\'' + t.id + '\')">Delete</button>' +
                    '</div>';
            }).join('');
        document.getElementById('tta-list').innerHTML = rows || '<div style="color:#94a3b8;text-align:center;padding:16px;">No types.</div>';
    }

    function byId(id) { return TYPES.filter(function (t) { return String(t.id) === String(id); })[0]; }

    // ── 2-step confirmation dialog ────────────────────────────────────────────
    function confirmStep(opts) {
        // opts: { title, bodyHtml, danger, extraHtml, onConfirm }
        confirmEl.innerHTML =
            '<div class="tta-cbox">' +
              '<h3>' + esc(opts.title) + '</h3>' +
              '<div style="font-size:13px;color:#475569;">' + (opts.bodyHtml || '') + '</div>' +
              (opts.extraHtml || '') +
              '<label class="tta-ack"><input type="checkbox" id="tta-ack"> I understand this change is logged and the developer will be notified.</label>' +
              '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
                '<button class="tta-btn tta-ghost" id="tta-cancel">Cancel</button>' +
                '<button class="tta-btn ' + (opts.danger ? 'tta-danger' : 'tta-primary') + '" id="tta-go" disabled style="opacity:.5;">Confirm</button>' +
              '</div>' +
            '</div>';
        confirmEl.classList.add('open');
        var ack = document.getElementById('tta-ack'), go = document.getElementById('tta-go');
        ack.addEventListener('change', function () { go.disabled = !ack.checked; go.style.opacity = ack.checked ? '1' : '.5'; });
        document.getElementById('tta-cancel').addEventListener('click', function () { confirmEl.classList.remove('open'); });
        go.addEventListener('click', function () {
            go.disabled = true; go.textContent = 'Working…';
            Promise.resolve(opts.onConfirm()).then(function (r) {
                confirmEl.classList.remove('open');
                if (r && r.success === false) { alert(r.message || 'Failed.'); }
                load();
            }).catch(function () { confirmEl.classList.remove('open'); alert('Failed.'); load(); });
        });
    }

    function addType() {
        var name = (document.getElementById('tta-new').value || '').trim();
        if (!name) return;
        if (TYPES.some(function (t) { return t.name.toLowerCase() === name.toLowerCase(); })) { alert('That type already exists.'); return; }
        confirmStep({
            title: 'Add terminal type',
            bodyHtml: 'Create a new terminal type <b>"' + esc(name) + '"</b> in the Terminal Type Manager?',
            onConfirm: function () { return api({ action: 'add_terminal_type', name: name }).then(function (r) { document.getElementById('tta-new').value = ''; return r; }); }
        });
    }

    window.__ttaRename = function (id) {
        var t = byId(id); if (!t) return;
        var nn = prompt('Rename "' + t.name + '" to:', t.name);
        if (nn == null) return; nn = nn.trim();
        if (!nn || nn === t.name) return;
        var c = COUNTS[t.name] || 0;
        confirmStep({
            title: 'Rename terminal type',
            bodyHtml: 'Rename <b>"' + esc(t.name) + '"</b> → <b>"' + esc(nn) + '"</b>.' + (c ? ' This will update <b>' + c + '</b> unit' + (c !== 1 ? 's' : '') + '.' : ''),
            onConfirm: function () { return api({ action: 'update_terminal_type', type_id: id, name: nn }); }
        });
    };

    window.__ttaMerge = function (id) {
        var src = byId(id); if (!src) return;
        var opts = TYPES.filter(function (t) { return String(t.id) !== String(id); })
            .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
            .map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + '</option>'; }).join('');
        var c = COUNTS[src.name] || 0;
        confirmStep({
            title: 'Merge terminal type',
            bodyHtml: 'Move all <b>' + c + '</b> unit' + (c !== 1 ? 's' : '') + ' from <b>"' + esc(src.name) + '"</b> into the type you pick below, then remove <b>"' + esc(src.name) + '"</b>.',
            extraHtml: '<div style="margin-top:12px;"><label class="ct" style="display:block;margin-bottom:4px;color:#475569;font-weight:800;">Merge into</label><select id="tta-merge-target" class="tta-inp"><option value="">— choose —</option>' + opts + '</select></div>',
            danger: true,
            onConfirm: function () {
                var target = document.getElementById('tta-merge-target').value;
                if (!target) { alert('Choose a target type.'); return { success: false }; }
                return api({ action: 'merge_terminal_type', source_id: id, target_id: target });
            }
        });
    };

    window.__ttaToggle = function (id) {
        var t = byId(id); if (!t) return;
        api({ action: 'update_terminal_type', type_id: id, is_active: !t.is_active }).then(load);
    };

    window.__ttaDelete = function (id) {
        var t = byId(id); if (!t) return;
        var c = COUNTS[t.name] || 0;
        confirmStep({
            title: 'Delete terminal type',
            bodyHtml: 'Delete <b>"' + esc(t.name) + '"</b> from the manager?' + (c ? ' <span style="color:#dc2626;font-weight:700;">' + c + ' unit' + (c !== 1 ? 's' : '') + ' still use this type</span> — consider Merge instead so those units keep a valid type.' : ''),
            danger: true,
            onConfirm: function () { return api({ action: 'delete_terminal_type', type_id: id }); }
        });
    };
    }
})();
