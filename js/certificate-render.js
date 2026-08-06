/*
 * Shared certificate renderer — used by the partner Certificate page and the
 * Secret Dungeon designer so both always look identical.
 *
 * window.CERT_TEMPLATES -> [{id,name,defaults:{colors},headingFont,bodyFont,dark}]
 * window.CERT_FONTS      -> [{value,label}]
 * window.renderCertificate(el, data)
 *
 * data = {
 *   template, colors:{bg,ink,body,accent,accent2,muted}, body_font, heading_font,
 *   org_name, logo_url, heading, pre_text, recipient_name, partner_title, body_text,
 *   cert_number, issued_date, signatories:[{name,title,image_url}],
 *   partner_logos:[{url,name}], partner_logos_label
 * }
 * Renders a fixed 1000x707 (A4-landscape ratio) .cert-canvas for clean capture.
 */
(function () {
    // ── fonts ────────────────────────────────────────────────────────────────
    var FONTS = [
        { value: 'DM Sans', label: 'DM Sans (clean sans)' },
        { value: 'Montserrat', label: 'Montserrat (modern sans)' },
        { value: 'Poppins', label: 'Poppins (geometric sans)' },
        { value: 'Cinzel', label: 'Cinzel (roman caps)' },
        { value: 'Playfair Display', label: 'Playfair Display (elegant serif)' },
        { value: 'Cormorant Garamond', label: 'Cormorant (refined serif)' },
        { value: 'EB Garamond', label: 'EB Garamond (classic serif)' },
        { value: 'Merriweather', label: 'Merriweather (sturdy serif)' },
        { value: 'Lora', label: 'Lora (book serif)' },
        { value: 'Great Vibes', label: 'Great Vibes (script)' },
        { value: 'Georgia', label: 'Georgia (system serif)' },
        { value: 'Arial', label: 'Arial (system sans)' }
    ];
    window.CERT_FONTS = FONTS;

    function ensureFonts() {
        if (document.getElementById('cert-google-fonts')) return;
        var l = document.createElement('link');
        l.id = 'cert-google-fonts';
        l.rel = 'stylesheet';
        l.href = 'https://fonts.googleapis.com/css2'
            + '?family=Cinzel:wght@500;600;700'
            + '&family=Playfair+Display:wght@600;700;800'
            + '&family=Cormorant+Garamond:wght@500;600;700'
            + '&family=EB+Garamond:wght@500;600;700'
            + '&family=Merriweather:wght@700;900'
            + '&family=Lora:wght@600;700'
            + '&family=Montserrat:wght@600;700;800'
            + '&family=Poppins:wght@600;700;800'
            + '&family=Great+Vibes&display=swap';
        document.head.appendChild(l);
    }

    var GENERIC = { 'DM Sans': 'sans-serif', 'Montserrat': 'sans-serif', 'Poppins': 'sans-serif', 'Arial': 'sans-serif', 'Cinzel': 'serif', 'Playfair Display': 'serif', 'Cormorant Garamond': 'serif', 'EB Garamond': 'serif', 'Merriweather': 'serif', 'Lora': 'serif', 'Georgia': 'serif', 'Great Vibes': 'cursive' };
    function ff(name) { return '"' + name + '",' + (GENERIC[name] || 'sans-serif'); }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }
    function fmtDate(v) {
        if (!v) return '';
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
        var d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
        if (isNaN(d.getTime())) return esc(v);
        var mo = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        return mo[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    }

    // ── decorative inline SVG ornaments (crisp + captured cleanly) ─────────────
    function svgSeal(a, b, ink) {
        return '<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">'
            + starburst(60, 60, 58, 50, 24, b)
            + '<circle cx="60" cy="60" r="44" fill="' + a + '"/>'
            + '<circle cx="60" cy="60" r="44" fill="none" stroke="' + b + '" stroke-width="2"/>'
            + '<circle cx="60" cy="60" r="34" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.5"/>'
            + star(60, 58, 20, 9, '#fff')
            + '</svg>';
    }
    function starburst(cx, cy, ro, ri, points, color) {
        var pts = [], i, ang, r;
        for (i = 0; i < points * 2; i++) {
            ang = (Math.PI / points) * i - Math.PI / 2;
            r = (i % 2 === 0) ? ro : ri;
            pts.push((cx + r * Math.cos(ang)).toFixed(1) + ',' + (cy + r * Math.sin(ang)).toFixed(1));
        }
        return '<polygon points="' + pts.join(' ') + '" fill="' + color + '"/>';
    }
    function star(cx, cy, ro, ri, color) {
        var pts = [], i, ang, r;
        for (i = 0; i < 10; i++) {
            ang = (Math.PI / 5) * i - Math.PI / 2;
            r = (i % 2 === 0) ? ro : ri;
            pts.push((cx + r * Math.cos(ang)).toFixed(1) + ',' + (cy + r * Math.sin(ang)).toFixed(1));
        }
        return '<polygon points="' + pts.join(' ') + '" fill="' + color + '"/>';
    }
    function svgRibbon(color) {
        return '<svg width="120" height="60" viewBox="0 0 120 60" fill="none" xmlns="http://www.w3.org/2000/svg">'
            + '<path d="M40 0 L40 52 L52 44 L60 56 L68 44 L80 52 L80 0 Z" fill="' + color + '"/>'
            + '</svg>';
    }
    function svgCorner(color) {
        return '<svg width="90" height="90" viewBox="0 0 90 90" fill="none" xmlns="http://www.w3.org/2000/svg">'
            + '<path d="M6 84 L6 30 Q6 6 30 6 L84 6" stroke="' + color + '" stroke-width="2" fill="none"/>'
            + '<path d="M16 84 L16 34 Q16 16 34 16 L84 16" stroke="' + color + '" stroke-width="1" fill="none" opacity=".6"/>'
            + '<circle cx="30" cy="30" r="4" fill="' + color + '"/>'
            + '</svg>';
    }
    function svgLaurel(color) {
        function branch(mx) {
            var g = '<g transform="translate(60,132) scale(' + mx + ',1)">';
            g += '<path d="M0 0 Q-26 -20 -34 -54" stroke="' + color + '" stroke-width="2.4" fill="none"/>';
            for (var i = 0; i < 6; i++) {
                var t = i / 6, x = -34 * t * 0.9, y = -54 * t;
                g += '<ellipse cx="' + (x - 8) + '" cy="' + (y - 4) + '" rx="8" ry="4" fill="' + color + '" opacity=".9" transform="rotate(' + (-40 - i * 6) + ' ' + (x - 8) + ' ' + (y - 4) + ')"/>';
            }
            return g + '</g>';
        }
        return '<svg width="150" height="150" viewBox="0 0 120 150" fill="none" xmlns="http://www.w3.org/2000/svg">' + branch(1) + branch(-1) + '</svg>';
    }
    function svgDivider(color) {
        return '<svg width="240" height="16" viewBox="0 0 240 16" fill="none" xmlns="http://www.w3.org/2000/svg">'
            + '<line x1="10" y1="8" x2="98" y2="8" stroke="' + color + '" stroke-width="1.5"/>'
            + '<line x1="142" y1="8" x2="230" y2="8" stroke="' + color + '" stroke-width="1.5"/>'
            + '<path d="M120 2 L127 8 L120 14 L113 8 Z" fill="' + color + '"/>'
            + '</svg>';
    }

    // ── shared content blocks ─────────────────────────────────────────────────
    function logo(url, dark, h) {
        if (!url) return '';
        return '<img class="cert-logo" src="' + esc(url) + '" alt="" style="max-height:' + (h || 52) + 'px;' + (dark ? 'filter:brightness(0) invert(1);' : '') + '">';
    }
    function sigs(list, C) {
        list = (list || []).filter(function (s) { return s && (s.name || s.title || s.image_url); }).slice(0, 5);
        if (!list.length) return '';
        return '<div class="cert-sigs">' + list.map(function (s) {
            var img = s.image_url ? '<img class="cert-sig-img" src="' + esc(s.image_url) + '">' : '<div class="cert-sig-img"></div>';
            return '<div class="cert-sig">' + img
                + '<div class="cert-sig-line" style="background:' + C.accent + '"></div>'
                + '<div class="cert-sig-name" style="color:' + C.ink + '">' + esc(s.name || '') + '</div>'
                + '<div class="cert-sig-title" style="color:' + C.muted + '">' + esc(s.title || '') + '</div>'
                + '</div>';
        }).join('') + '</div>';
    }
    function plogos(d, C) {
        var list = (d.partner_logos || []).filter(function (x) { return x && x.url; }).slice(0, 14);
        if (!list.length) return '';
        var label = d.partner_logos_label || 'In partnership with';
        return '<div class="cert-plg"><div class="cert-plg-l" style="color:' + C.muted + '">' + esc(label) + '</div>'
            + '<div class="cert-plg-row">' + list.map(function (x) {
                return '<span class="cert-plg-chip"><img class="cert-plg-img" src="' + esc(x.url) + '"></span>';
            }).join('') + '</div></div>';
    }
    function foot(d, C) {
        return '<div class="cert-foot" style="color:' + C.muted + '"><span>' + esc(d.cert_number || '') + '</span>'
            + '<span>Issued ' + fmtDate(d.issued_date) + '</span></div>';
    }
    // Central content column shared by most templates.
    function core(d, C, F, HF, opt) {
        opt = opt || {};
        var bodyLine = esc(d.body_text) + ' <b style="color:' + C.ink + '">' + esc(d.partner_title) + '</b> of ' + esc(d.org_name) + '.';
        return '<div class="cert-col">'
            + '<div class="cert-top">' + logo(d.logo_url, d.dark, 46) + '<div class="cert-org" style="color:' + C.accent + '">' + esc(d.org_name) + '</div></div>'
            + '<div class="cert-mid">'
            + '<div class="cert-kicker" style="color:' + C.accent + ';font-family:' + HF + '">' + esc(d.heading || 'Certificate of Partnership') + '</div>'
            + '<div class="cert-pre" style="color:' + C.muted + '">' + esc(d.pre_text || 'This certifies that') + '</div>'
            + '<div class="cert-name" style="color:' + C.ink + ';font-family:' + HF + '">' + esc(d.recipient_name) + '</div>'
            + '<div class="cert-div">' + svgDivider(C.accent) + '</div>'
            + '<div class="cert-body" style="color:' + C.body + '">' + bodyLine + '</div>'
            + '</div>'
            + sigs(d.signatories, C)
            + plogos(d, C)
            + foot(d, C)
            + '</div>';
    }

    // ── templates ──────────────────────────────────────────────────────────────
    // Each: { id, name, dark, headingFont, bodyFont, colors, render(d,C,F,HF) }
    var T = [];
    function reg(def) { T.push(def); }

    reg({ id: 'classic', name: 'Classic Gold', headingFont: 'Playfair Display', bodyFont: 'DM Sans',
        colors: { bg: '#fffdf7', ink: '#2a2313', body: '#4a4230', accent: '#b98a2e', accent2: '#e3c163', muted: '#8a7c58' },
        render: function (d, C, F, HF) {
            return frame(C, F, 'padding:22px;',
                '<div style="height:100%;border:3px solid ' + C.accent + ';border-radius:6px;padding:6px;">'
                + '<div style="height:100%;border:1px solid ' + C.accent2 + ';border-radius:4px;position:relative;padding:34px 60px;">'
                + corners(C.accent) + core(d, C, F, HF) + '</div></div>');
        } });

    reg({ id: 'modern', name: 'Modern Teal', headingFont: 'Montserrat', bodyFont: 'DM Sans',
        colors: { bg: '#ffffff', ink: '#0f172a', body: '#475569', accent: '#0d9488', accent2: '#5eead4', muted: '#94a3b8' },
        render: function (d, C, F, HF) {
            return frame(C, F, '',
                '<div style="height:14px;background:linear-gradient(90deg,' + C.accent + ',' + C.accent2 + ');"></div>'
                + '<div style="height:calc(100% - 14px);position:relative;padding:34px 66px;">' + core(d, C, F, HF) + '</div>');
        } });

    reg({ id: 'elegant', name: 'Elegant Navy', dark: true, headingFont: 'Cinzel', bodyFont: 'EB Garamond',
        colors: { bg: '#0b1120', ink: '#ffffff', body: '#cdd7ea', accent: '#c9a227', accent2: '#e7c86a', muted: '#8ea0bf' },
        render: function (d, C, F, HF) {
            return frame(C, F, 'padding:22px;background:radial-gradient(circle at 50% 15%,#16233f,' + C.bg + ');',
                '<div style="height:100%;border:2px solid ' + C.accent + ';border-radius:4px;position:relative;padding:34px 62px;">'
                + corners(C.accent) + core(d, C, F, HF) + '</div>');
        } });

    reg({ id: 'minimal', name: 'Minimal', headingFont: 'Montserrat', bodyFont: 'DM Sans',
        colors: { bg: '#ffffff', ink: '#111827', body: '#4b5563', accent: '#111827', accent2: '#9ca3af', muted: '#9ca3af' },
        render: function (d, C, F, HF) {
            var bodyLine = esc(d.body_text) + ' <b>' + esc(d.partner_title) + '</b> of ' + esc(d.org_name) + '.';
            return frame(C, F, 'border:1px solid #e5e7eb;',
                '<div style="position:relative;height:100%;padding:66px 84px;display:flex;flex-direction:column;justify-content:center;">'
                + '<div class="cert-top" style="justify-content:flex-start;margin-bottom:22px;">' + logo(d.logo_url, false, 40) + '<div class="cert-org" style="color:' + C.ink + '">' + esc(d.org_name) + '</div></div>'
                + '<div style="font-size:13px;font-weight:700;letter-spacing:5px;text-transform:uppercase;color:' + C.muted + ';font-family:' + HF + ';">' + esc(d.heading || 'Certificate of Partnership') + '</div>'
                + '<div style="font-size:52px;font-weight:800;color:' + C.ink + ';margin:10px 0 14px;letter-spacing:-1.5px;font-family:' + HF + ';">' + esc(d.recipient_name) + '</div>'
                + '<div style="font-size:16px;line-height:1.7;color:' + C.body + ';max-width:680px;">' + bodyLine + '</div>'
                + '<div style="margin-top:24px;">' + sigsLeft(d.signatories, C) + '</div>'
                + plogosLeft(d, C)
                + foot(d, C) + '</div>');
        } });

    reg({ id: 'corporate', name: 'Corporate', headingFont: 'Montserrat', bodyFont: 'DM Sans',
        colors: { bg: '#ffffff', ink: '#0f172a', body: '#475569', accent: '#0f172a', accent2: '#5eead4', muted: '#94a3b8' },
        render: function (d, C, F, HF) {
            return frame(C, F, '',
                '<div style="background:linear-gradient(120deg,' + C.accent + ',#1e293b);color:#fff;padding:30px 60px;display:flex;align-items:center;gap:16px;">'
                + logo(d.logo_url, true, 42) + '<div style="font-size:16px;font-weight:800;letter-spacing:2px;text-transform:uppercase;">' + esc(d.org_name) + '</div>'
                + '<div style="margin-left:auto;font-size:19px;font-weight:800;letter-spacing:1px;color:' + C.accent2 + ';font-family:' + HF + ';">' + esc(d.heading || 'Certificate of Partnership') + '</div></div>'
                + '<div style="position:relative;height:calc(100% - 102px);padding:30px 60px;">' + coreNoTop(d, C, F, HF) + '</div>');
        } });

    reg({ id: 'royal', name: 'Royal Seal', headingFont: 'Cinzel', bodyFont: 'EB Garamond',
        colors: { bg: '#fbf7ef', ink: '#3a2f5a', body: '#4a4260', accent: '#6d4aa1', accent2: '#c9a227', muted: '#8b7fa6' },
        render: function (d, C, F, HF) {
            return frame(C, F, 'padding:20px;',
                '<div style="height:100%;border:2.5px double ' + C.accent + ';border-radius:6px;position:relative;padding:30px 64px;">'
                + corners(C.accent2)
                + '<div style="position:absolute;top:18px;left:50%;transform:translateX(-50%);">' + svgSeal(C.accent, C.accent2) + '</div>'
                + '<div style="padding-top:96px;">' + core(d, C, F, HF) + '</div></div>');
        } });

    reg({ id: 'laurel', name: 'Laurel Wreath', headingFont: 'Cormorant Garamond', bodyFont: 'Lora',
        colors: { bg: '#ffffff', ink: '#14532d', body: '#3f6212', accent: '#15803d', accent2: '#bbf7d0', muted: '#84a98c' },
        render: function (d, C, F, HF) {
            return frame(C, F, 'padding:20px;',
                '<div style="height:100%;border:1.5px solid ' + C.accent + ';border-radius:8px;position:relative;padding:30px 64px;">'
                + '<div style="position:absolute;top:14px;left:50%;transform:translateX(-50%) scale(.78);transform-origin:top center;opacity:.9;">' + svgLaurel(C.accent) + '</div>'
                + '<div style="height:100%;padding-top:118px;">' + core(d, C, F, HF) + '</div></div>');
        } });

    reg({ id: 'monogram', name: 'Monogram', headingFont: 'Playfair Display', bodyFont: 'DM Sans',
        colors: { bg: '#faf9fc', ink: '#1e1b2e', body: '#4b4763', accent: '#7c3aed', accent2: '#c4b5fd', muted: '#9c96b8' },
        render: function (d, C, F, HF) {
            var mono = (String(d.recipient_name || d.org_name || 'P').trim()[0] || 'P').toUpperCase();
            return frame(C, F, 'padding:0;',
                '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:' + HF + ';font-size:520px;font-weight:800;color:' + C.accent + ';opacity:.06;">' + esc(mono) + '</div>'
                + '<div style="position:relative;height:100%;padding:40px 70px;border:1px solid ' + C.accent2 + ';margin:18px;border-radius:10px;">' + core(d, C, F, HF) + '</div>');
        } });

    reg({ id: 'gradient', name: 'Vivid Gradient', dark: true, headingFont: 'Poppins', bodyFont: 'DM Sans',
        colors: { bg: '#0f172a', ink: '#ffffff', body: '#e2e8f0', accent: '#22d3ee', accent2: '#a78bfa', muted: '#a5b4cf' },
        render: function (d, C, F, HF) {
            return frame(C, F, 'background:linear-gradient(135deg,#4338ca 0%,#0ea5e9 55%,#06b6d4 130%);padding:26px;',
                '<div style="height:100%;background:rgba(9,14,30,.62);border:1px solid rgba(255,255,255,.25);border-radius:16px;position:relative;padding:32px 60px;backdrop-filter:blur(2px);">' + core(d, C, F, HF) + '</div>');
        } });

    reg({ id: 'platinum', name: 'Platinum', headingFont: 'Montserrat', bodyFont: 'DM Sans',
        colors: { bg: '#f8fafc', ink: '#1e293b', body: '#475569', accent: '#64748b', accent2: '#cbd5e1', muted: '#94a3b8' },
        render: function (d, C, F, HF) {
            return frame(C, F, 'padding:0;',
                '<div style="position:absolute;top:0;left:0;width:0;height:0;border-top:180px solid ' + C.accent2 + ';border-right:180px solid transparent;opacity:.5;"></div>'
                + '<div style="position:absolute;bottom:0;right:0;width:0;height:0;border-bottom:180px solid ' + C.accent2 + ';border-left:180px solid transparent;opacity:.5;"></div>'
                + '<div style="position:relative;height:100%;padding:40px 66px;border:2px solid ' + C.accent + ';margin:20px;border-radius:4px;">' + core(d, C, F, HF) + '</div>');
        } });

    reg({ id: 'artdeco', name: 'Art Deco', dark: true, headingFont: 'Cinzel', bodyFont: 'Montserrat',
        colors: { bg: '#10241f', ink: '#f5f3e7', body: '#d6e0d2', accent: '#e0b973', accent2: '#c9a227', muted: '#9fb3a0' },
        render: function (d, C, F, HF) {
            return frame(C, F, 'padding:20px;',
                '<div style="height:100%;border:2px solid ' + C.accent + ';position:relative;padding:34px 64px;">'
                + '<div style="position:absolute;inset:6px;border:1px solid ' + C.accent2 + ';opacity:.6;"></div>'
                + decoFan(C.accent, 'top') + decoFan(C.accent, 'bottom')
                + '<div style="position:relative;">' + core(d, C, F, HF) + '</div></div>');
        } });

    reg({ id: 'botanical', name: 'Botanical', headingFont: 'Cormorant Garamond', bodyFont: 'Lora',
        colors: { bg: '#fdfaf6', ink: '#42583f', body: '#5b6b52', accent: '#7d9d6f', accent2: '#d9c8a9', muted: '#9aa890' },
        render: function (d, C, F, HF) {
            return frame(C, F, 'padding:18px;',
                '<div style="height:100%;border:1px solid ' + C.accent + ';border-radius:12px;position:relative;padding:34px 64px;overflow:hidden;">'
                + '<div style="position:absolute;top:-30px;left:-30px;opacity:.5;transform:rotate(20deg);">' + svgLaurel(C.accent) + '</div>'
                + '<div style="position:absolute;bottom:-40px;right:-30px;opacity:.5;transform:rotate(200deg);">' + svgLaurel(C.accent) + '</div>'
                + '<div style="position:relative;">' + core(d, C, F, HF) + '</div></div>');
        } });

    reg({ id: 'neongrid', name: 'Neon Grid', dark: true, headingFont: 'Poppins', bodyFont: 'DM Sans',
        colors: { bg: '#0a0f1e', ink: '#e0f2fe', body: '#a5c4dd', accent: '#38bdf8', accent2: '#818cf8', muted: '#6b7fa3' },
        render: function (d, C, F, HF) {
            var grid = 'background-image:linear-gradient(rgba(56,189,248,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(56,189,248,.09) 1px,transparent 1px);background-size:34px 34px;';
            return frame(C, F, 'padding:24px;' + grid,
                '<div style="height:100%;border:1px solid ' + C.accent + ';border-radius:10px;position:relative;padding:34px 60px;box-shadow:inset 0 0 40px rgba(56,189,248,.15);">' + core(d, C, F, HF) + '</div>');
        } });

    reg({ id: 'ribbon', name: 'Award Ribbon', headingFont: 'Merriweather', bodyFont: 'DM Sans',
        colors: { bg: '#fff8f5', ink: '#7c2d12', body: '#7c4a3a', accent: '#c2410c', accent2: '#f59e0b', muted: '#b08a7a' },
        render: function (d, C, F, HF) {
            return frame(C, F, 'padding:20px;',
                '<div style="height:100%;border:2px solid ' + C.accent + ';border-radius:6px;position:relative;padding:30px 64px;">'
                + '<div style="position:absolute;top:14px;left:50%;transform:translateX(-50%);text-align:center;">' + svgSeal(C.accent, C.accent2) + '<div style="margin-top:-8px;">' + svgRibbon(C.accent2) + '</div></div>'
                + '<div style="padding-top:150px;">' + core(d, C, F, HF) + '</div></div>');
        } });

    reg({ id: 'emblem', name: 'Emblem Guilloché', headingFont: 'Playfair Display', bodyFont: 'EB Garamond',
        colors: { bg: '#f7f9fc', ink: '#1e2a44', body: '#3d4a63', accent: '#1d4ed8', accent2: '#93c5fd', muted: '#8595b5' },
        render: function (d, C, F, HF) {
            var guilloche = 'background-image:repeating-radial-gradient(circle at 50% 42%,transparent 0,transparent 16px,rgba(29,78,216,.05) 17px,transparent 18px);';
            return frame(C, F, 'padding:20px;' + guilloche,
                '<div style="height:100%;border:2px solid ' + C.accent + ';border-radius:8px;position:relative;padding:30px 64px;">'
                + corners(C.accent2)
                + '<div style="position:absolute;top:16px;left:50%;transform:translateX(-50%);">' + svgSeal(C.accent, C.accent2) + '</div>'
                + '<div style="padding-top:100px;">' + core(d, C, F, HF) + '</div></div>');
        } });

    // ── helpers used by templates ─────────────────────────────────────────────
    function frame(C, F, extra, inner) {
        return '<div class="cert-canvas" style="background:' + C.bg + ';font-family:' + F + ';' + (extra || '') + '">' + inner + '</div>';
    }
    function corners(color) {
        return '<div class="cert-corner tl">' + svgCorner(color) + '</div>'
            + '<div class="cert-corner tr">' + svgCorner(color) + '</div>'
            + '<div class="cert-corner bl">' + svgCorner(color) + '</div>'
            + '<div class="cert-corner br">' + svgCorner(color) + '</div>';
    }
    function decoFan(color, pos) {
        var top = pos === 'top';
        var s = '<div style="position:absolute;' + (top ? 'top:14px' : 'bottom:14px') + ';left:50%;transform:translateX(-50%);display:flex;gap:4px;align-items:flex-end;">';
        for (var i = 0; i < 7; i++) { var h = 6 + Math.abs(3 - i) * 5; s += '<div style="width:4px;height:' + (26 - h) + 'px;background:' + color + ';opacity:.8;"></div>'; }
        return s + '</div>';
    }
    function coreNoTop(d, C, F, HF) {
        var bodyLine = esc(d.body_text) + ' <b style="color:' + C.ink + '">' + esc(d.partner_title) + '</b> of ' + esc(d.org_name) + '.';
        return '<div class="cert-col"><div class="cert-mid" style="padding-top:6px;">'
            + '<div class="cert-pre" style="color:' + C.muted + '">' + esc(d.pre_text || 'This is to certify that') + '</div>'
            + '<div class="cert-name" style="color:' + C.ink + ';font-family:' + HF + '">' + esc(d.recipient_name) + '</div>'
            + '<div class="cert-div">' + svgDivider(C.accent) + '</div>'
            + '<div class="cert-body" style="color:' + C.body + '">' + bodyLine + '</div></div>'
            + sigs(d.signatories, C) + plogos(d, C) + foot(d, C) + '</div>';
    }
    function sigsLeft(list, C) { var h = sigs(list, C); return h.replace('class="cert-sigs"', 'class="cert-sigs" style="justify-content:flex-start"'); }
    function plogosLeft(d, C) { var h = plogos(d, C); return h.replace('class="cert-plg"', 'class="cert-plg" style="align-items:flex-start"'); }

    var RMAP = {}; T.forEach(function (t) { RMAP[t.id] = t; });
    window.CERT_TEMPLATES = T.map(function (t) { return { id: t.id, name: t.name, colors: t.colors, dark: !!t.dark, headingFont: t.headingFont, bodyFont: t.bodyFont }; });

    // ── styles ─────────────────────────────────────────────────────────────────
    var CSS = ''
        + '.cert-canvas{width:1000px;height:707px;position:relative;box-sizing:border-box;overflow:hidden;}'
        + '.cert-canvas *{box-sizing:border-box;}'
        + '.cert-logo{display:block;object-fit:contain;}'
        + '.cert-col{position:relative;height:100%;display:flex;flex-direction:column;}'
        + '.cert-top{display:flex;align-items:center;justify-content:center;gap:13px;padding-top:2px;}'
        + '.cert-org{font-size:15px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;}'
        + '.cert-mid{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;}'
        + '.cert-kicker{font-size:33px;font-weight:700;margin:2px 0 10px;line-height:1.1;}'
        + '.cert-pre{font-size:14px;letter-spacing:1px;}'
        + '.cert-name{font-size:50px;font-weight:700;margin:6px 0 2px;line-height:1.1;}'
        + '.cert-div{margin:8px 0 12px;}'
        + '.cert-body{font-size:16px;line-height:1.6;max-width:660px;}'
        + '.cert-sigs{display:flex;justify-content:center;gap:54px;margin-top:20px;flex-wrap:wrap;}'
        + '.cert-sig{width:180px;text-align:center;}'
        + '.cert-sig-img{width:150px;height:46px;object-fit:contain;margin:0 auto 3px;display:block;}'
        + '.cert-sig-line{height:2px;width:100%;margin:0 0 7px;}'
        + '.cert-sig-name{font-size:15px;font-weight:800;line-height:1.2;}'
        + '.cert-sig-title{font-size:11.5px;font-weight:600;margin-top:2px;}'
        + '.cert-plg{margin-top:16px;text-align:center;}'
        + '.cert-plg-l{font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;}'
        + '.cert-plg-row{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;}'
        + '.cert-plg-chip{background:#fff;border:1px solid rgba(0,0,0,.10);border-radius:7px;padding:5px 9px;display:inline-flex;align-items:center;justify-content:center;}'
        + '.cert-plg-img{max-height:28px;max-width:100px;object-fit:contain;display:block;}'
        + '.cert-foot{margin-top:14px;padding-top:8px;display:flex;justify-content:space-between;font-size:12px;font-weight:600;letter-spacing:1px;}'
        + '.cert-corner{position:absolute;}.cert-corner.tl{top:8px;left:8px;}.cert-corner.tr{top:8px;right:8px;transform:scaleX(-1);}'
        + '.cert-corner.bl{bottom:8px;left:8px;transform:scaleY(-1);}.cert-corner.br{bottom:8px;right:8px;transform:scale(-1,-1);}';

    function ensureStyles() {
        if (document.getElementById('cert-render-styles')) return;
        var st = document.createElement('style'); st.id = 'cert-render-styles'; st.textContent = CSS; document.head.appendChild(st);
    }

    function resolveColors(tpl, override) {
        var base = tpl.colors || {}; var o = override || {}; var out = {};
        ['bg', 'ink', 'body', 'accent', 'accent2', 'muted'].forEach(function (k) { out[k] = (o[k] && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(o[k])) ? o[k] : base[k]; });
        return out;
    }

    window.renderCertificate = function (el, data) {
        ensureFonts(); ensureStyles();
        if (!el) return;
        var d = data || {};
        var tpl = RMAP[d.template] || RMAP.classic;
        var C = resolveColors(tpl, d.colors);
        var F = ff(d.body_font || tpl.bodyFont || 'DM Sans');
        var HF = ff(d.heading_font || tpl.headingFont || 'Playfair Display');
        var safe = {
            template: tpl.id, dark: !!tpl.dark,
            org_name: d.org_name || 'PayProTec',
            logo_url: d.logo_url || '',
            heading: d.heading || 'Certificate of Partnership',
            pre_text: d.pre_text || '',
            recipient_name: d.recipient_name || 'Partner Name',
            partner_title: d.partner_title || 'Certified Partner',
            body_text: d.body_text || 'has successfully graduated and is hereby recognized as a',
            cert_number: d.cert_number || 'PPT-0000-0000',
            issued_date: d.issued_date || '',
            signatories: d.signatories || [],
            partner_logos: d.partner_logos || [],
            partner_logos_label: d.partner_logos_label || 'In partnership with'
        };
        el.innerHTML = tpl.render(safe, C, F, HF);
        return el.firstElementChild;
    };
})();
