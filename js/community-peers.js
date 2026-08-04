/* Shared "Peers" (connections) UI for the staff + partner community pages.
 * Each page must define, before using:
 *   window.CAPI(body)        -> Promise<json>  (calls /api/community with auth)
 *   window.CURRENT_UID       -> my user id
 * Depends on SweetAlert2 (Swal) which both community pages already load.
 */
(function () {
  function CAPI(b) { return window.CAPI(b); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }
  function initials(n) { return String(n || '?').trim().split(/\s+/).map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 2); }
  function avatar(p, size) {
    size = size || 44;
    var s = 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;flex-shrink:0;object-fit:cover;';
    if (p && p.avatar_url) return '<img src="' + esc(p.avatar_url) + '" style="' + s + '">';
    return '<div style="' + s + 'display:flex;align-items:center;justify-content:center;background:#2563eb;color:#fff;font-weight:800;font-size:' + Math.round(size / 2.6) + 'px;">' + esc(initials(p && p.display_name)) + '</div>';
  }
  function typePill(t) { return '<span style="font-size:10px;font-weight:800;border-radius:20px;padding:2px 8px;background:' + (t === 'staff' ? '#dbeafe;color:#1d4ed8' : '#dcfce7;color:#166534') + ';">' + (t === 'staff' ? 'Staff' : 'Partner') + '</span>'; }

  function personRow(p, actionHtml) {
    return '<div style="display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid #f1f5f9;">' +
      '<span style="cursor:pointer;" onclick="PeerUI.openProfile(\'' + esc(p.user_id) + '\')">' + avatar(p, 40) + '</span>' +
      '<div style="flex:1;min-width:0;cursor:pointer;" onclick="PeerUI.openProfile(\'' + esc(p.user_id) + '\')">' +
        '<div style="font-weight:700;font-size:13.5px;">' + esc(p.display_name || 'Member') + ' ' + typePill(p.user_type) + '</div>' +
        (p.company ? '<div style="font-size:11.5px;color:#94a3b8;">🏢 ' + esc(p.company) + '</div>' : (p.tagline ? '<div style="font-size:11.5px;color:#94a3b8;">' + esc(p.tagline) + '</div>' : '')) +
      '</div>' + (actionHtml || '') + '</div>';
  }
  function actionFor(p) {
    var s = p.peer_status;
    if (s === 'peers') return '<span style="font-size:12px;font-weight:700;color:#16a34a;">✓ Peer</span>';
    if (s === 'pending_out') return '<span style="font-size:12px;color:#94a3b8;">Requested</span>';
    if (s === 'pending_in') return '<button class="pu-btn pu-primary" onclick="PeerUI.respond(\'' + esc(p.user_id) + '\',\'accept\')">Accept</button>';
    return '<button class="pu-btn pu-primary" onclick="PeerUI.send(\'' + esc(p.user_id) + '\',\'' + esc(p.user_type) + '\')">+ Add Peer</button>';
  }

  // ── Profile modal ──
  function openProfile(uid) {
    CAPI({ action: 'get_profile', user_id: uid }).then(function (r) {
      if (!r || !r.success) { Swal.fire('Error', (r && r.message) || 'Profile not found', 'error'); return; }
      var p = r.data, st = r.peer_status, cnt = r.peer_count || 0, self = st === 'self';
      var action = '';
      if (self) action = '<button class="pu-btn pu-neutral" onclick="PeerUI.editProfile()">Edit my profile</button>';
      else if (st === 'peers') action = '<button class="pu-btn pu-neutral" onclick="PeerUI.remove(\'' + esc(p.user_id) + '\')">✓ Peers · Remove</button>';
      else if (st === 'pending_out') action = '<button class="pu-btn pu-neutral" disabled>Request sent</button>';
      else if (st === 'pending_in') action = '<button class="pu-btn pu-primary" onclick="PeerUI.respond(\'' + esc(p.user_id) + '\',\'accept\')">Accept</button> <button class="pu-btn pu-neutral" onclick="PeerUI.respond(\'' + esc(p.user_id) + '\',\'decline\')">Decline</button>';
      else action = '<button class="pu-btn pu-primary" onclick="PeerUI.send(\'' + esc(p.user_id) + '\',\'' + esc(p.user_type) + '\')">+ Add a Peer</button>';
      var body = '<div style="text-align:center;">' + avatar(p, 84).replace('width:84px', 'width:84px;margin:0 auto') +
        '<div style="font-weight:800;font-size:17px;margin-top:10px;">' + esc(p.display_name || 'Member') + ' ' + typePill(p.user_type) + '</div>' +
        (p.tagline ? '<div style="color:#475569;font-size:13px;margin-top:2px;">' + esc(p.tagline) + '</div>' : '') +
        '<div style="color:#94a3b8;font-size:12px;margin-top:4px;">👥 ' + cnt + ' peer' + (cnt === 1 ? '' : 's') + '</div>' +
        '<div style="margin:14px 0;">' + action + '</div>';
      if (p.locked) {
        body += '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;color:#64748b;font-size:12.5px;">🔒 This profile is private. Connect as a peer to see more.' + (p.company ? '<div style="margin-top:6px;">🏢 ' + esc(p.company) + '</div>' : '') + '</div>';
      } else {
        var det = [];
        if (p.company) det.push('🏢 ' + esc(p.company));
        if (p.location) det.push('📍 ' + esc(p.location));
        if (p.website) det.push('🔗 <a href="' + esc(p.website) + '" target="_blank" rel="noopener" style="color:#2563eb;">' + esc(p.website) + '</a>');
        if (det.length) body += '<div style="text-align:left;font-size:12.5px;color:#475569;line-height:1.9;">' + det.join('<br>') + '</div>';
        if (p.bio) body += '<div style="text-align:left;font-size:13px;color:#334155;margin-top:10px;white-space:pre-wrap;border-top:1px solid #f1f5f9;padding-top:10px;">' + esc(p.bio) + '</div>';
      }
      body += '</div>';
      Swal.fire({ html: body, showConfirmButton: true, confirmButtonText: 'Close', confirmButtonColor: '#64748b', width: 460 });
    });
  }

  // ── Edit my profile ──
  function editProfile() {
    CAPI({ action: 'get_profile', user_id: window.CURRENT_UID }).then(function (r) {
      var p = (r && r.data) || {};
      Swal.fire({
        title: 'Edit my profile', width: 500,
        html: '<div style="text-align:left;">' +
          '<label class="pu-lbl">Headline</label><input id="pf-tag" class="swal2-input pu-in" placeholder="e.g. POS Sales Partner" value="' + esc(p.tagline || '') + '">' +
          '<label class="pu-lbl">Company / affiliation</label><input id="pf-co" class="swal2-input pu-in" placeholder="e.g. PayProTec" value="' + esc(p.company || '') + '">' +
          '<label class="pu-lbl">Location</label><input id="pf-loc" class="swal2-input pu-in" value="' + esc(p.location || '') + '">' +
          '<label class="pu-lbl">Website</label><input id="pf-web" class="swal2-input pu-in" placeholder="https://…" value="' + esc(p.website || '') + '">' +
          '<label class="pu-lbl">About</label><textarea id="pf-bio" class="swal2-textarea pu-in">' + esc(p.bio || '') + '</textarea>' +
          '<label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;cursor:pointer;"><input type="checkbox" id="pf-pub" style="width:auto;" ' + (p.is_public === false ? '' : 'checked') + '> Public profile <span style="color:#94a3b8;">(uncheck to lock — only peers see your details)</span></label>' +
          '</div>',
        showCancelButton: true, confirmButtonText: 'Save', confirmButtonColor: '#2563eb',
        preConfirm: function () {
          return { tagline: v('pf-tag'), company: v('pf-co'), location: v('pf-loc'), website: v('pf-web'), bio: v('pf-bio'), is_public: document.getElementById('pf-pub').checked };
        }
      }).then(function (res) {
        if (!res.isConfirmed) return;
        CAPI(Object.assign({ action: 'update_profile' }, res.value)).then(function (rr) {
          if (rr && rr.success) Swal.fire({ icon: 'success', title: 'Saved', timer: 1100, showConfirmButton: false });
          else Swal.fire('Error', (rr && rr.message) || 'Could not save', 'error');
        });
      });
    });
  }
  function v(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }

  // ── Peers modal (Requests / My peers / Find people) ──
  var curTab = 'requests';
  function openPeers(tab) {
    curTab = tab || 'requests';
    Swal.fire({
      title: '👥 Peers', width: 540, showConfirmButton: true, confirmButtonText: 'Close', confirmButtonColor: '#64748b',
      html: '<div style="text-align:left;">' +
        '<div id="pu-tabs" style="display:flex;gap:6px;margin-bottom:10px;">' +
          '<button class="pu-tab" data-t="requests" onclick="PeerUI.tab(\'requests\')">Requests</button>' +
          '<button class="pu-tab" data-t="peers" onclick="PeerUI.tab(\'peers\')">My Peers</button>' +
          '<button class="pu-tab" data-t="find" onclick="PeerUI.tab(\'find\')">Find People</button>' +
        '</div><div id="pu-body" style="min-height:180px;max-height:56vh;overflow:auto;"></div></div>',
      didOpen: function () { renderTab(curTab); }
    });
  }
  function setTab(t) { curTab = t; renderTab(t); }
  function renderTab(t) {
    curTab = t;
    document.querySelectorAll('#pu-tabs .pu-tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-t') === t); });
    var box = document.getElementById('pu-body'); if (!box) return;
    box.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:24px;">Loading…</div>';
    if (t === 'requests') {
      CAPI({ action: 'list_peer_requests' }).then(function (r) {
        var list = (r && r.data) || [];
        box.innerHTML = list.length ? list.map(function (p) {
          return personRow(p, '<button class="pu-btn pu-primary" onclick="PeerUI.respond(\'' + esc(p.user_id) + '\',\'accept\')">Accept</button> <button class="pu-btn pu-neutral" onclick="PeerUI.respond(\'' + esc(p.user_id) + '\',\'decline\')">Decline</button>');
        }).join('') : '<div style="text-align:center;color:#94a3b8;padding:24px;">No pending requests.</div>';
      });
    } else if (t === 'peers') {
      CAPI({ action: 'list_peers' }).then(function (r) {
        var list = (r && r.data) || [];
        box.innerHTML = list.length ? list.map(function (p) { return personRow(Object.assign({ peer_status: 'peers' }, p), '<span style="font-size:12px;color:#16a34a;font-weight:700;">✓ Peer</span>'); }).join('')
          : '<div style="text-align:center;color:#94a3b8;padding:24px;">No peers yet. Use “Find People” to connect.</div>';
      });
    } else {
      box.innerHTML = '<input id="pu-search" class="pu-in" style="width:100%;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:9px;font-size:13px;margin-bottom:8px;" placeholder="Search people by name or company…"><div id="pu-results" style="color:#94a3b8;text-align:center;padding:16px;">Type a name or company to search.</div>';
      var inp = document.getElementById('pu-search'); inp.focus();
      var timer = null;
      inp.oninput = function () { clearTimeout(timer); var q = inp.value.trim(); timer = setTimeout(function () { doSearch(q); }, 250); };
    }
  }
  function doSearch(q) {
    var box = document.getElementById('pu-results'); if (!box) return;
    if (q.length < 2) { box.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:16px;">Type at least 2 letters.</div>'; return; }
    box.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:16px;">Searching…</div>';
    CAPI({ action: 'search_people', q: q }).then(function (r) {
      var list = (r && r.data) || [];
      box.innerHTML = list.length ? list.map(function (p) { return personRow(p, actionFor(p)); }).join('') : '<div style="text-align:center;color:#94a3b8;padding:16px;">No matches.</div>';
    });
  }

  // ── Actions ──
  function send(id, type) { CAPI({ action: 'send_peer_request', addressee_id: id, addressee_type: type }).then(function (r) { if (r && r.success) { Swal.fire({ icon: 'success', title: r.peer_status === 'peers' ? 'You are now peers' : 'Request sent', timer: 1200, showConfirmButton: false }); refreshBadge(); } else Swal.fire('Error', (r && r.message) || 'Could not send', 'error'); }); }
  function respond(id, decision) { CAPI({ action: 'respond_peer_request', requester_id: id, decision: decision }).then(function (r) { if (r && r.success) { Swal.fire({ icon: 'success', title: decision === 'accept' ? 'Peer added' : 'Declined', timer: 1100, showConfirmButton: false }); refreshBadge(); if (document.getElementById('pu-body')) renderTab(curTab); } else Swal.fire('Error', (r && r.message) || 'Failed', 'error'); }); }
  function remove(id) { Swal.fire({ icon: 'warning', title: 'Remove peer?', showCancelButton: true, confirmButtonColor: '#dc2626' }).then(function (x) { if (!x.isConfirmed) return; CAPI({ action: 'remove_peer', peer_id: id }).then(function () { Swal.fire({ icon: 'success', title: 'Removed', timer: 900, showConfirmButton: false }); refreshBadge(); }); }); }

  function refreshBadge() {
    CAPI({ action: 'list_peer_requests' }).then(function (r) {
      var n = (r && r.count) || 0;
      document.querySelectorAll('[data-peer-badge]').forEach(function (el) { el.textContent = n; el.style.display = n ? 'inline-block' : 'none'; });
    }).catch(function () {});
    if (document.getElementById('peersList')) renderPeersList('peersList');
    if (document.getElementById('peopleStrip')) renderSuggestions('peopleStrip');
  }

  // Square rounded avatar (Facebook friends-box style).
  function avatarSq(p) {
    var base = 'width:100%;aspect-ratio:1;border-radius:10px;object-fit:cover;display:block;';
    if (p && p.avatar_url) return '<img src="' + esc(p.avatar_url) + '" style="' + base + '">';
    return '<div style="' + base + 'display:flex;align-items:center;justify-content:center;background:#2563eb;color:#fff;font-weight:800;font-size:22px;">' + esc(initials(p && p.display_name)) + '</div>';
  }
  // ── "People you may know" carousel ──
  function sugCard(p) {
    return '<div style="flex:0 0 150px;border:1px solid #e2e8f0;border-radius:12px;padding:12px;text-align:center;background:#fff;">' +
      '<div style="cursor:pointer;width:64px;margin:0 auto;" onclick="PeerUI.openProfile(\'' + esc(p.user_id) + '\')">' + avatarSq(p) + '</div>' +
      '<div style="font-weight:700;font-size:12.5px;margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;" onclick="PeerUI.openProfile(\'' + esc(p.user_id) + '\')">' + esc(p.display_name || 'Member') + '</div>' +
      '<div style="font-size:10.5px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">' + esc(p.reason || '') + '</div>' +
      '<button class="pu-btn pu-primary" style="width:100%;margin-top:8px;" onclick="PeerUI.suggestAdd(this,\'' + esc(p.user_id) + '\',\'' + esc(p.user_type) + '\')">+ Add Peer</button>' +
    '</div>';
  }
  function renderSuggestions(containerId) {
    var box = document.getElementById(containerId); if (!box) return;
    CAPI({ action: 'suggested_people' }).then(function (r) {
      var list = (r && r.data) || [];
      if (!list.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
      box.style.display = '';
      var sid = containerId + '-scroll';
      box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin:0 2px 8px;">' +
          '<span style="font-weight:800;font-size:13px;color:#334155;">People you may know</span>' +
          '<span><span title="Show different people" style="cursor:pointer;color:#64748b;font-size:14px;margin-right:12px;" onclick="PeerUI.renderSuggestions(\'' + containerId + '\')">🔄</span>' +
          '<span style="font-size:11.5px;color:#2563eb;cursor:pointer;font-weight:700;" onclick="PeerUI.openSuggestions()">See all</span></span>' +
        '</div>' +
        '<div style="position:relative;">' +
          '<button class="sug-arrow" style="left:-8px;" onclick="PeerUI.scrollStrip(\'' + sid + '\',-1)">‹</button>' +
          '<div id="' + sid + '" style="display:flex;gap:10px;overflow-x:auto;scroll-behavior:smooth;padding:2px 4px;">' + list.map(sugCard).join('') + '</div>' +
          '<button class="sug-arrow" style="right:-8px;" onclick="PeerUI.scrollStrip(\'' + sid + '\',1)">›</button>' +
        '</div>';
    });
  }
  function scrollStrip(sid, dir) { var el = document.getElementById(sid); if (el) el.scrollBy({ left: dir * 330, behavior: 'smooth' }); }
  function suggestAdd(btn, id, type) {
    CAPI({ action: 'send_peer_request', addressee_id: id, addressee_type: type }).then(function (r) {
      if (r && r.success) { btn.textContent = r.peer_status === 'peers' ? '✓ Peer' : 'Requested'; btn.disabled = true; btn.className = 'pu-btn pu-neutral'; refreshBadge(); }
    });
  }
  function openSuggestions() {
    Swal.fire({
      title: 'People you may know', width: 560,
      html: '<div id="sug-all" style="text-align:left;min-height:140px;max-height:60vh;overflow:auto;">Loading…</div>',
      showConfirmButton: true, confirmButtonText: 'Close', confirmButtonColor: '#64748b',
      didOpen: function () {
        CAPI({ action: 'suggested_people', all: true }).then(function (r) {
          var l = (r && r.data) || [], box = document.getElementById('sug-all');
          box.innerHTML = l.length ? l.map(function (p) { return personRow(p, actionFor({ user_id: p.user_id, user_type: p.user_type, peer_status: 'none' })); }).join('') : '<div style="text-align:center;color:#94a3b8;padding:24px;">No suggestions right now.</div>';
        });
      }
    });
  }
  // ── Peers "box" (Facebook-style friends grid) ──
  function renderPeersList(containerId) {
    var box = document.getElementById(containerId); if (!box) return;
    CAPI({ action: 'list_peers' }).then(function (r) {
      var list = (r && r.data) || [];
      var tiles = list.slice(0, 9).map(function (p) {
        return '<div style="cursor:pointer;min-width:0;" onclick="PeerUI.openProfile(\'' + esc(p.user_id) + '\')">' + avatarSq(p) +
          '<div style="font-weight:600;font-size:11.5px;margin-top:5px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(p.display_name || 'Member') + '</div></div>';
      }).join('');
      box.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 2px 8px;">' +
          '<span style="font-weight:800;font-size:13px;color:#334155;">Your Peers <span style="color:#94a3b8;">(' + list.length + ')</span></span>' +
          (list.length ? '<span style="font-size:11.5px;color:#2563eb;cursor:pointer;font-weight:700;" onclick="PeerUI.openPeers(\'peers\')">See all</span>' : '') +
        '</div>' +
        (list.length ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:12px;">' + tiles + '</div>'
          : '<div style="color:#94a3b8;font-size:12px;padding:6px 2px;">No peers yet — use “Find People” to connect.</div>');
    });
  }

  window.PeerUI = { openProfile: openProfile, editProfile: editProfile, openPeers: openPeers, tab: setTab, send: send, respond: respond, remove: remove, refreshBadge: refreshBadge, renderSuggestions: renderSuggestions, suggestAdd: suggestAdd, renderPeersList: renderPeersList, scrollStrip: scrollStrip, openSuggestions: openSuggestions };

  // Styles + auto-open from ?peers=1
  var css = document.createElement('style');
  css.textContent = '.pu-btn{border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;}.pu-primary{background:#2563eb;color:#fff;}.pu-neutral{background:#f1f5f9;color:#334155;}.pu-tab{border:1px solid #e2e8f0;background:#fff;border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:700;cursor:pointer;color:#475569;font-family:inherit;}.pu-tab.on{background:#2563eb;color:#fff;border-color:#2563eb;}.pu-lbl{display:block;font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.4px;margin:12px 0 4px;}.pu-in{margin:0!important;width:100%!important;box-sizing:border-box;}.peer-row{display:flex;align-items:center;gap:8px;padding:6px;border-radius:8px;cursor:pointer;}.peer-row:hover{background:#f1f5f9;}.sug-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:2;width:28px;height:28px;border-radius:50%;border:1px solid #e2e8f0;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12);cursor:pointer;font-size:16px;line-height:1;color:#334155;display:flex;align-items:center;justify-content:center;}.sug-arrow:hover{background:#f1f5f9;}';
  document.head.appendChild(css);
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(refreshBadge, 800);
    try { if (new URLSearchParams(location.search).get('peers')) setTimeout(function () { openPeers('requests'); }, 600); } catch (e) {}
  });
})();
