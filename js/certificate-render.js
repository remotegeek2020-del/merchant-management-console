/*
 * Shared certificate renderer — used by the partner Certificate page and the
 * Secret Dungeon settings live-preview so both always look identical.
 *
 * window.CERT_TEMPLATES  -> [{id,name}] for pickers.
 * window.renderCertificate(el, data) -> paints the certificate into `el`.
 *
 * data = {
 *   template, org_name, logo_url, recipient_name, partner_title, body_text,
 *   cert_number, issued_date (YYYY-MM-DD or Date-ish string),
 *   signatories: [{ name, title, image_url }]
 * }
 * The rendered node is a fixed 1000x707 (A4-landscape ratio) .cert-canvas so it
 * captures cleanly to PDF/PNG at any zoom.
 */
(function () {
    var TEMPLATES = [
        { id: 'classic', name: 'Classic Gold' },
        { id: 'modern', name: 'Modern Teal' },
        { id: 'elegant', name: 'Elegant Navy' },
        { id: 'minimal', name: 'Minimal' },
        { id: 'corporate', name: 'Corporate' }
    ];
    window.CERT_TEMPLATES = TEMPLATES;

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function fmtDate(v) {
        if (!v) return '';
        // Accept 'YYYY-MM-DD' or ISO; render "Month D, YYYY" without TZ drift.
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
        var d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
        if (isNaN(d.getTime())) return esc(v);
        var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
            'August', 'September', 'October', 'November', 'December'];
        return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    }

    function sigBlocks(sigs, opts) {
        opts = opts || {};
        var color = opts.color || '#0f172a';
        var line = opts.line || '#94a3b8';
        var list = (sigs || []).filter(function (s) { return s && (s.name || s.title); }).slice(0, 5);
        if (!list.length) return '';
        return '<div class="cert-sigs">' + list.map(function (s) {
            var img = s.image_url
                ? '<img class="cert-sig-img" src="' + esc(s.image_url) + '" alt="">'
                : '<div class="cert-sig-img"></div>';
            return '<div class="cert-sig">'
                + img
                + '<div class="cert-sig-line" style="background:' + line + '"></div>'
                + '<div class="cert-sig-name" style="color:' + color + '">' + esc(s.name || '') + '</div>'
                + '<div class="cert-sig-title">' + esc(s.title || '') + '</div>'
                + '</div>';
        }).join('') + '</div>';
    }

    function logo(url, opts) {
        opts = opts || {};
        if (!url) return '';
        return '<img class="cert-logo" src="' + esc(url) + '" alt="" style="max-height:' + (opts.h || 54) + 'px;' + (opts.invert ? 'filter:brightness(0) invert(1);' : '') + '">';
    }

    // ── individual template markup ────────────────────────────────────────────
    function tClassic(d) {
        return ''
            + '<div class="cert-canvas t-classic">'
            + '  <div class="cc-border"><div class="cc-inner">'
            + '    <div class="cc-corner tl"></div><div class="cc-corner tr"></div>'
            + '    <div class="cc-corner bl"></div><div class="cc-corner br"></div>'
            + '    <div class="cc-top">' + logo(d.logo_url, { h: 50 }) + '<div class="cc-org">' + esc(d.org_name) + '</div></div>'
            + '    <div class="cc-kicker">Certificate of Partnership</div>'
            + '    <div class="cc-pre">This certifies that</div>'
            + '    <div class="cc-name">' + esc(d.recipient_name) + '</div>'
            + '    <div class="cc-rule"></div>'
            + '    <div class="cc-body">' + esc(d.body_text) + ' <b>' + esc(d.partner_title) + '</b> of ' + esc(d.org_name) + '.</div>'
            + sigBlocks(d.signatories, { color: '#3b2f14', line: '#b98a2e' })
            + '    <div class="cc-foot"><span>' + esc(d.cert_number) + '</span><span>Issued ' + fmtDate(d.issued_date) + '</span></div>'
            + '  </div></div>'
            + '</div>';
    }
    function tModern(d) {
        return ''
            + '<div class="cert-canvas t-modern">'
            + '  <div class="cm-bar"></div>'
            + '  <div class="cm-pad">'
            + '    <div class="cm-top">' + logo(d.logo_url, { h: 46 }) + '<div class="cm-org">' + esc(d.org_name) + '</div></div>'
            + '    <div class="cm-kicker">CERTIFICATE OF PARTNERSHIP</div>'
            + '    <div class="cm-pre">Awarded to</div>'
            + '    <div class="cm-name">' + esc(d.recipient_name) + '</div>'
            + '    <div class="cm-body">' + esc(d.body_text) + ' <b>' + esc(d.partner_title) + '</b> of ' + esc(d.org_name) + '.</div>'
            + sigBlocks(d.signatories, { color: '#0f766e', line: '#5eead4' })
            + '    <div class="cm-foot"><span>' + esc(d.cert_number) + '</span><span>Issued ' + fmtDate(d.issued_date) + '</span></div>'
            + '  </div>'
            + '</div>';
    }
    function tElegant(d) {
        return ''
            + '<div class="cert-canvas t-elegant">'
            + '  <div class="ce-frame">'
            + '    <div class="ce-top">' + logo(d.logo_url, { h: 48, invert: true }) + '<div class="ce-org">' + esc(d.org_name) + '</div></div>'
            + '    <div class="ce-kicker">Certificate of Partnership</div>'
            + '    <div class="ce-pre">Proudly presented to</div>'
            + '    <div class="ce-name">' + esc(d.recipient_name) + '</div>'
            + '    <div class="ce-rule"></div>'
            + '    <div class="ce-body">' + esc(d.body_text) + ' <b>' + esc(d.partner_title) + '</b> of ' + esc(d.org_name) + '.</div>'
            + sigBlocks(d.signatories, { color: '#f8fafc', line: '#c9a227' })
            + '    <div class="ce-foot"><span>' + esc(d.cert_number) + '</span><span>Issued ' + fmtDate(d.issued_date) + '</span></div>'
            + '  </div>'
            + '</div>';
    }
    function tMinimal(d) {
        return ''
            + '<div class="cert-canvas t-minimal">'
            + '  <div class="cmi-pad">'
            + '    <div class="cmi-top">' + logo(d.logo_url, { h: 40 }) + '<div class="cmi-org">' + esc(d.org_name) + '</div></div>'
            + '    <div class="cmi-kicker">Certificate of Partnership</div>'
            + '    <div class="cmi-name">' + esc(d.recipient_name) + '</div>'
            + '    <div class="cmi-body">' + esc(d.body_text) + ' <b>' + esc(d.partner_title) + '</b> of ' + esc(d.org_name) + '.</div>'
            + sigBlocks(d.signatories, { color: '#111827', line: '#d1d5db' })
            + '    <div class="cmi-foot"><span>' + esc(d.cert_number) + '</span><span>Issued ' + fmtDate(d.issued_date) + '</span></div>'
            + '  </div>'
            + '</div>';
    }
    function tCorporate(d) {
        return ''
            + '<div class="cert-canvas t-corporate">'
            + '  <div class="cco-head">' + logo(d.logo_url, { h: 44, invert: true }) + '<div class="cco-org">' + esc(d.org_name) + '</div>'
            + '    <div class="cco-headline">Certificate of Partnership</div></div>'
            + '  <div class="cco-pad">'
            + '    <div class="cco-pre">This is to certify that</div>'
            + '    <div class="cco-name">' + esc(d.recipient_name) + '</div>'
            + '    <div class="cco-body">' + esc(d.body_text) + ' <b>' + esc(d.partner_title) + '</b> of ' + esc(d.org_name) + '.</div>'
            + sigBlocks(d.signatories, { color: '#0f172a', line: '#94a3b8' })
            + '    <div class="cco-foot"><span>' + esc(d.cert_number) + '</span><span>Issued ' + fmtDate(d.issued_date) + '</span></div>'
            + '  </div>'
            + '</div>';
    }

    var RENDERERS = { classic: tClassic, modern: tModern, elegant: tElegant, minimal: tMinimal, corporate: tCorporate };

    // ── styles (injected once) ────────────────────────────────────────────────
    var CSS = ''
        + '.cert-canvas{width:1000px;height:707px;position:relative;box-sizing:border-box;background:#fff;font-family:"DM Sans",Arial,sans-serif;overflow:hidden;}'
        + '.cert-canvas *{box-sizing:border-box;}'
        + '.cert-logo{display:block;object-fit:contain;}'
        + '.cert-sigs{display:flex;justify-content:center;gap:60px;margin-top:34px;flex-wrap:wrap;}'
        + '.cert-sig{width:180px;text-align:center;}'
        + '.cert-sig-img{width:150px;height:52px;object-fit:contain;margin:0 auto 4px;display:block;}'
        + '.cert-sig-line{height:2px;width:100%;margin:0 0 8px;}'
        + '.cert-sig-name{font-size:16px;font-weight:800;line-height:1.2;}'
        + '.cert-sig-title{font-size:12px;color:#64748b;font-weight:600;margin-top:2px;}'
        // classic
        + '.t-classic{background:#fffdf7;padding:22px;}'
        + '.t-classic .cc-border{height:100%;border:3px solid #b98a2e;border-radius:6px;padding:8px;}'
        + '.t-classic .cc-inner{height:100%;border:1px solid #d8b968;border-radius:4px;padding:40px 60px;position:relative;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;}'
        + '.t-classic .cc-corner{position:absolute;width:26px;height:26px;border:3px solid #b98a2e;}'
        + '.t-classic .cc-corner.tl{top:14px;left:14px;border-right:none;border-bottom:none;}'
        + '.t-classic .cc-corner.tr{top:14px;right:14px;border-left:none;border-bottom:none;}'
        + '.t-classic .cc-corner.bl{bottom:14px;left:14px;border-right:none;border-top:none;}'
        + '.t-classic .cc-corner.br{bottom:14px;right:14px;border-left:none;border-top:none;}'
        + '.t-classic .cc-top{display:flex;align-items:center;gap:14px;margin-bottom:8px;}'
        + '.t-classic .cc-org{font-size:16px;font-weight:800;letter-spacing:2px;color:#3b2f14;text-transform:uppercase;}'
        + '.t-classic .cc-kicker{font-family:Georgia,"Times New Roman",serif;font-size:34px;font-weight:700;color:#b98a2e;margin:6px 0 14px;}'
        + '.t-classic .cc-pre{font-size:14px;color:#7c6b45;letter-spacing:1px;}'
        + '.t-classic .cc-name{font-family:Georgia,serif;font-size:48px;font-weight:700;color:#2a2313;margin:6px 0 4px;}'
        + '.t-classic .cc-rule{width:280px;height:2px;background:#b98a2e;margin:6px 0 16px;}'
        + '.t-classic .cc-body{font-size:16px;color:#4a4230;max-width:640px;line-height:1.6;}'
        + '.t-classic .cc-foot{position:absolute;bottom:26px;left:60px;right:60px;display:flex;justify-content:space-between;font-size:12px;color:#8a7c58;font-weight:600;letter-spacing:1px;}'
        // modern
        + '.t-modern{background:#fff;padding:0;}'
        + '.t-modern .cm-bar{height:14px;background:linear-gradient(90deg,#0d9488,#14b8a6,#5eead4);}'
        + '.t-modern .cm-pad{padding:46px 70px;text-align:center;display:flex;flex-direction:column;align-items:center;height:calc(100% - 14px);justify-content:center;position:relative;}'
        + '.t-modern .cm-top{display:flex;align-items:center;gap:12px;margin-bottom:10px;}'
        + '.t-modern .cm-org{font-size:15px;font-weight:800;letter-spacing:2px;color:#0f766e;text-transform:uppercase;}'
        + '.t-modern .cm-kicker{font-size:15px;font-weight:800;letter-spacing:4px;color:#0d9488;margin:8px 0 18px;}'
        + '.t-modern .cm-pre{font-size:14px;color:#64748b;}'
        + '.t-modern .cm-name{font-size:52px;font-weight:800;color:#0f172a;margin:4px 0 12px;letter-spacing:-1px;}'
        + '.t-modern .cm-body{font-size:16px;color:#475569;max-width:640px;line-height:1.6;}'
        + '.t-modern .cm-foot{position:absolute;bottom:26px;left:70px;right:70px;display:flex;justify-content:space-between;font-size:12px;color:#94a3b8;font-weight:700;letter-spacing:1px;}'
        // elegant
        + '.t-elegant{background:#0b1120;padding:22px;}'
        + '.t-elegant .ce-frame{height:100%;border:2px solid #c9a227;border-radius:4px;padding:44px 64px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;background:radial-gradient(circle at 50% 20%,#16233f,#0b1120);}'
        + '.t-elegant .ce-top{display:flex;align-items:center;gap:14px;margin-bottom:8px;}'
        + '.t-elegant .ce-org{font-size:15px;font-weight:800;letter-spacing:3px;color:#c9a227;text-transform:uppercase;}'
        + '.t-elegant .ce-kicker{font-family:Georgia,serif;font-size:32px;color:#e7c86a;margin:8px 0 14px;font-weight:700;}'
        + '.t-elegant .ce-pre{font-size:13px;color:#9fb0cc;letter-spacing:2px;text-transform:uppercase;}'
        + '.t-elegant .ce-name{font-family:Georgia,serif;font-size:50px;color:#fff;margin:8px 0 4px;font-weight:700;}'
        + '.t-elegant .ce-rule{width:260px;height:2px;background:linear-gradient(90deg,transparent,#c9a227,transparent);margin:6px 0 16px;}'
        + '.t-elegant .ce-body{font-size:16px;color:#cdd7ea;max-width:640px;line-height:1.6;}'
        + '.t-elegant .ce-foot{position:absolute;bottom:24px;left:64px;right:64px;display:flex;justify-content:space-between;font-size:12px;color:#8ea0bf;font-weight:600;letter-spacing:1px;}'
        // minimal
        + '.t-minimal{background:#fff;border:1px solid #e5e7eb;}'
        + '.t-minimal .cmi-pad{padding:70px 90px;height:100%;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;position:relative;}'
        + '.t-minimal .cmi-top{display:flex;align-items:center;gap:12px;margin-bottom:26px;}'
        + '.t-minimal .cmi-org{font-size:14px;font-weight:800;letter-spacing:3px;color:#111827;text-transform:uppercase;}'
        + '.t-minimal .cmi-kicker{font-size:13px;font-weight:700;letter-spacing:5px;color:#9ca3af;text-transform:uppercase;}'
        + '.t-minimal .cmi-name{font-size:54px;font-weight:800;color:#111827;margin:10px 0 16px;letter-spacing:-1.5px;}'
        + '.t-minimal .cmi-body{font-size:16px;color:#4b5563;max-width:680px;line-height:1.7;}'
        + '.t-minimal .cert-sigs{justify-content:flex-start;}'
        + '.t-minimal .cert-sig{text-align:left;}.t-minimal .cert-sig-img{margin-left:0;}'
        + '.t-minimal .cmi-foot{position:absolute;bottom:34px;left:90px;right:90px;display:flex;justify-content:space-between;font-size:12px;color:#9ca3af;font-weight:600;letter-spacing:1px;}'
        // corporate
        + '.t-corporate{background:#fff;}'
        + '.t-corporate .cco-head{background:linear-gradient(120deg,#0f172a,#1e293b);color:#fff;padding:32px 60px;display:flex;align-items:center;gap:16px;position:relative;}'
        + '.t-corporate .cco-org{font-size:16px;font-weight:800;letter-spacing:2px;text-transform:uppercase;}'
        + '.t-corporate .cco-headline{margin-left:auto;font-size:20px;font-weight:800;letter-spacing:1px;color:#5eead4;}'
        + '.t-corporate .cco-pad{padding:44px 60px;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;height:calc(100% - 108px);}'
        + '.t-corporate .cco-pre{font-size:14px;color:#64748b;letter-spacing:1px;}'
        + '.t-corporate .cco-name{font-size:50px;font-weight:800;color:#0f172a;margin:6px 0 14px;letter-spacing:-1px;}'
        + '.t-corporate .cco-body{font-size:16px;color:#475569;max-width:660px;line-height:1.6;}'
        + '.t-corporate .cco-foot{position:absolute;bottom:24px;left:60px;right:60px;display:flex;justify-content:space-between;font-size:12px;color:#94a3b8;font-weight:700;letter-spacing:1px;}';

    function ensureStyles() {
        if (document.getElementById('cert-render-styles')) return;
        var st = document.createElement('style');
        st.id = 'cert-render-styles';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    window.renderCertificate = function (el, data) {
        ensureStyles();
        if (!el) return;
        var d = data || {};
        var fn = RENDERERS[d.template] || RENDERERS.classic;
        var safe = {
            template: d.template,
            org_name: d.org_name || 'PayProTec',
            logo_url: d.logo_url || '',
            recipient_name: d.recipient_name || 'Partner Name',
            partner_title: d.partner_title || 'Certified Partner',
            body_text: d.body_text || 'has successfully graduated and is hereby recognized as a',
            cert_number: d.cert_number || 'PPT-0000-0000',
            issued_date: d.issued_date || '',
            signatories: d.signatories || []
        };
        el.innerHTML = fn(safe);
        return el.firstElementChild;
    };
})();
