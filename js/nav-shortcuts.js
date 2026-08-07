(function () {
  var MODULES = [
    { key: 'leads',       label: 'Prospects',      url: '/leads',                  icon: 'person_search',       color: '#0d9488', bg: '#ccfbf1', access: 'pp_access_prospects', highlight: true },
    { key: 'inventory',   label: 'Inventory',     url: '/equipments-dashboard',  icon: 'inventory_2',         color: '#0369a1', bg: '#dbeafe', access: 'pp_access_inventory' },
    { key: 'roi',         label: 'Equipment ROI', url: '/equipment-roi',          icon: 'insights',            color: '#0d9488', bg: '#ccfbf1', access: 'pp_access_inventory' },
    { key: 'repair',      label: 'Repair Queue',  url: '/repair-queue',           icon: 'build',               color: '#dc2626', bg: '#fee2e2', access: 'pp_access_inventory' },
    { key: 'deployments', label: 'Deployments',   url: '/deployments-dashboard',  icon: 'local_shipping',      color: '#7c3aed', bg: '#ede9fe', access: 'pp_access_deployments' },
    { key: 'returns',     label: 'Returns',        url: '/returns-dashboard',      icon: 'assignment_return',   color: '#d97706', bg: '#fef3c7', access: 'pp_access_returns' },
    { key: 'merchants',   label: 'Merchants',      url: '/merchants-dashboard',    icon: 'storefront',          color: '#166534', bg: '#dcfce7', access: 'pp_access_merchants' },
    { key: 'partners',    label: 'Partners',       url: '/partners-dashboard',     icon: 'handshake',           color: '#004990', bg: '#dbeafe', access: 'pp_access_partners' },
    { key: 'tickets',     label: 'Tickets',        url: '/tickets-dashboard',      icon: 'confirmation_number', color: '#0d9488', bg: '#ccfbf1', access: null },
    { key: 'tasks',       label: 'Tasks',          url: '/tasks-dashboard',        icon: 'assignment',          color: '#92400e', bg: '#fef3c7', access: null },
  ];

  function canSee(mod) {
    var role = localStorage.getItem('pp_role') || '';
    if (role === 'super_admin' || role === 'admin') return true;
    if (!mod.access) return true;
    return localStorage.getItem(mod.access) === 'true';
  }

  function currentKey() {
    return (window.NAV_SHORTCUT_PAGE || '').toLowerCase();
  }

  function ensureStyle() {
    if (document.getElementById('navsc-style')) return;
    var st = document.createElement('style');
    st.id = 'navsc-style';
    st.textContent = '@keyframes navscPulse{0%,100%{box-shadow:0 0 0 0 rgba(13,148,136,.5);}50%{box-shadow:0 0 0 7px rgba(13,148,136,0);}}';
    document.head.appendChild(st);
  }

  // Live badge: number of NEW prospects, so the pill demands attention when it matters.
  function loadLeadCount() {
    var badge = document.getElementById('navsc-leads-badge');
    if (!badge) return;
    var token = localStorage.getItem('pp_session_token') || '';
    fetch('/api/lead-portal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ action: 'count_new_leads' }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.success && d.count > 0) { badge.textContent = d.count > 99 ? '99+' : d.count; badge.style.display = 'inline-flex'; }
      }).catch(function () {});
  }

  function inject() {
    var header = document.querySelector('.modern-header');
    if (!header) return;
    if (document.getElementById('nav-shortcuts-strip')) return;
    ensureStyle();

    var cur = currentKey();
    var visible = MODULES.filter(function (m) { return m.key !== cur && canSee(m); });
    if (!visible.length) return;

    var strip = document.createElement('div');
    strip.id = 'nav-shortcuts-strip';
    strip.style.cssText = [
      'display:flex',
      'flex-wrap:wrap',
      'gap:6px',
      'padding:8px 24px 10px',
      'background:#f8fafc',
      'border-bottom:1px solid #e2e8f0',
      'margin-top:-8px',
      'border-radius:0 0 14px 14px',
    ].join(';');

    visible.forEach(function (mod) {
      var a = document.createElement('a');
      a.href = mod.url;
      if (mod.highlight) {
        // A filled, larger, gently pulsing pill with a live count badge so it
        // clearly stands out from the rest.
        a.id = 'navsc-' + mod.key + '-pill';
        a.style.cssText = [
          'display:inline-flex', 'align-items:center', 'gap:5px',
          'padding:5px 15px', 'background:' + mod.color, 'color:#fff',
          'border:1px solid ' + mod.color, 'border-radius:20px',
          'font-size:12.5px', 'font-weight:800', 'text-decoration:none',
          'white-space:nowrap', 'position:relative',
          'animation:navscPulse 2s ease-in-out infinite',
          'transition:transform .15s',
        ].join(';');
        a.innerHTML = '<span class="material-icons" style="font-size:15px;">' + mod.icon + '</span>' + mod.label
          + '<span id="navsc-' + mod.key + '-badge" style="display:none;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;margin-left:3px;background:#ef4444;color:#fff;border-radius:99px;font-size:10px;font-weight:800;line-height:1;box-shadow:0 0 0 2px ' + mod.color + ';">0</span>';
        a.addEventListener('mouseenter', function () { this.style.transform = 'translateY(-1px) scale(1.05)'; });
        a.addEventListener('mouseleave', function () { this.style.transform = ''; });
        strip.appendChild(a);
        return;
      }
      a.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'gap:4px',
        'padding:3px 10px',
        'background:' + mod.bg,
        'color:' + mod.color,
        'border:1px solid ' + mod.color + '33',
        'border-radius:20px',
        'font-size:11px',
        'font-weight:700',
        'text-decoration:none',
        'transition:background .15s,color .15s',
        'white-space:nowrap',
      ].join(';');
      a.innerHTML = '<span class="material-icons" style="font-size:12px;">' + mod.icon + '</span>' + mod.label;
      a.addEventListener('mouseenter', function () {
        this.style.background = mod.color;
        this.style.color = '#fff';
      });
      a.addEventListener('mouseleave', function () {
        this.style.background = mod.bg;
        this.style.color = mod.color;
      });
      strip.appendChild(a);
    });

    header.insertAdjacentElement('afterend', strip);
    if (document.getElementById('navsc-leads-badge')) loadLeadCount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
