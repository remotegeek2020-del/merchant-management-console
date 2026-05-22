(function () {
  var MODULES = [
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

  function inject() {
    var header = document.querySelector('.modern-header');
    if (!header) return;
    if (document.getElementById('nav-shortcuts-strip')) return;

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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
