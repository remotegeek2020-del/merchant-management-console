/*
 * Staff homepage announcements (marketing). Renders active 'staff'/'both'
 * campaigns into #staffAnnCarousel on the hub. Graphic + hotspots, text, CTA,
 * carousel, per-user dismiss; tracks impressions/clicks via /api/marketing.
 * Self-contained: injects its own CSS. Include after site-config.js.
 */
(function () {
    var token = localStorage.getItem('pp_session_token') || '';
    var list = [], idx = 0, wrap = null;

    function esc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function api(body) { return fetch('/api/marketing', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(body) }).then(function (r) { return r.json(); }); }
    function track(id, type, target) { api({ action: 'track', campaign_id: id, event_type: type, target: target || null }).catch(function () {}); }

    window.staffAnnClick = function (id, t) { track(id, 'click', t); };
    window.staffAnnNav = function (d) { idx = Math.max(0, Math.min(list.length - 1, idx + d)); render(); };
    window.staffAnnDismiss = function (id) {
        track(id, 'dismiss');
        api({ action: 'dismiss', campaign_id: id });
        list = list.filter(function (c) { return c.id !== id; });
        if (idx >= list.length) idx = Math.max(0, list.length - 1);
        render();
    };

    function injectCss() {
        if (document.getElementById('staff-ann-css')) return;
        var s = document.createElement('style'); s.id = 'staff-ann-css';
        s.textContent = [
            '.sann-card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,0.06);overflow:hidden;position:relative;}',
            '.sann-imgwrap{position:relative;display:block;line-height:0;}',
            '.sann-imgwrap img{width:100%;display:block;}',
            '.sann-hotspot{position:absolute;display:block;cursor:pointer;border-radius:6px;}',
            '.sann-hotspot:hover{background:rgba(0,73,144,0.12);box-shadow:0 0 0 2px rgba(0,73,144,0.5) inset;}',
            '.sann-body{padding:18px 20px;}',
            '.sann-title{font-size:1.05rem;font-weight:800;color:#0a1628;margin:0 0 6px;}',
            '.sann-text{font-size:13px;color:#475569;line-height:1.6;white-space:pre-wrap;}',
            '.sann-cta{display:inline-flex;align-items:center;gap:6px;margin-top:14px;background:#004990;color:#fff;border:none;border-radius:10px;padding:10px 18px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;text-decoration:none;}',
            '.sann-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px;border-top:1px solid #e2e8f0;background:#fafbfc;flex-wrap:wrap;}',
            '.sann-dismiss{display:flex;align-items:center;gap:7px;font-size:12px;color:#64748b;cursor:pointer;}',
            '.sann-nav{display:flex;align-items:center;gap:6px;font-size:12px;color:#64748b;font-weight:700;}',
            '.sann-nav button{background:#fff;border:1px solid #e2e8f0;border-radius:8px;width:26px;height:26px;cursor:pointer;font-size:14px;line-height:1;color:#475569;}',
            '.sann-nav button:disabled{opacity:.4;cursor:default;}',
            '.sann-x{position:absolute;top:10px;right:10px;z-index:3;background:rgba(0,0,0,0.45);color:#fff;border:none;border-radius:50%;width:28px;height:28px;cursor:pointer;display:flex;align-items:center;justify-content:center;}'
        ].join('');
        document.head.appendChild(s);
    }

    function render() {
        if (!wrap) return;
        if (!list.length) { wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
        var c = list[idx];
        var showGraphic = (c.content_type === 'graphic' || c.content_type === 'both') && c.image_url;
        var showText = (c.content_type === 'text' || c.content_type === 'both');
        var html = '<div class="sann-card">';
        html += '<button class="sann-x" title="Dismiss" onclick="staffAnnDismiss(\'' + c.id + '\')"><span class="material-icons" style="font-size:18px;">close</span></button>';
        if (showGraphic) {
            var hs = (c.hotspots || []).filter(function (h) { return h.url; }).map(function (h) {
                return '<a class="sann-hotspot" href="' + esc(h.url) + '" target="_blank" rel="noopener" style="left:' + h.x + '%;top:' + h.y + '%;width:' + h.w + '%;height:' + h.h + '%;" title="' + esc(h.label || '') + '" onclick="staffAnnClick(\'' + c.id + '\',\'' + esc(h.id || 'hotspot') + '\')"></a>';
            }).join('');
            html += '<div class="sann-imgwrap"><img src="' + esc(c.image_url) + '" alt="' + esc(c.title) + '">' + hs + '</div>';
        }
        if (showText || (c.cta_enabled && c.cta_url)) {
            html += '<div class="sann-body">';
            if (showText && c.title) html += '<div class="sann-title">' + esc(c.title) + '</div>';
            if (showText && c.body_text) html += '<div class="sann-text">' + esc(c.body_text) + '</div>';
            if (c.cta_enabled && c.cta_url) html += '<a class="sann-cta" href="' + esc(c.cta_url) + '" target="_blank" rel="noopener" onclick="staffAnnClick(\'' + c.id + '\',\'cta\')">' + esc(c.cta_label || 'Learn more') + ' <span class="material-icons" style="font-size:16px;">arrow_forward</span></a>';
            html += '</div>';
        }
        html += '<div class="sann-foot">';
        html += '<label class="sann-dismiss"><input type="checkbox" onchange="if(this.checked)staffAnnDismiss(\'' + c.id + '\')"> Don\'t show this again</label>';
        if (list.length > 1) html += '<span class="sann-nav"><button onclick="staffAnnNav(-1)" ' + (idx === 0 ? 'disabled' : '') + '>‹</button> ' + (idx + 1) + ' / ' + list.length + ' <button onclick="staffAnnNav(1)" ' + (idx === list.length - 1 ? 'disabled' : '') + '>›</button></span>';
        html += '</div></div>';
        wrap.innerHTML = html;
        track(c.id, 'impression');
    }

    function load() {
        wrap = document.getElementById('staffAnnCarousel');
        if (!wrap || !token) return;
        api({ action: 'get_active' }).then(function (d) {
            if (!d.success || !Array.isArray(d.data) || !d.data.length) return;
            list = d.data; idx = 0; injectCss(); wrap.style.display = ''; render();
        }).catch(function () {});
    }

    if (document.readyState !== 'loading') load();
    else document.addEventListener('DOMContentLoaded', load);
})();
