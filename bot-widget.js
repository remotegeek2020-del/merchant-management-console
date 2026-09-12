/*  PayProTec website bot — embeddable chat widget (Phase 1)
 *  Drop this on any page (Webflow, GoHighLevel, your own site):
 *  <script src="https://<host>/bot-widget.js" data-bot="partner-info"></script>
 *  Multiple bots can be embedded on the same page (each needs a distinct
 *  data-bot slug) — every element/id below is namespaced per bot instance.
 */
(function () {
    'use strict';
    var self = document.currentScript;
    if (!self || !/bot-widget\.js/.test(self.src || '')) {
        var ss = document.getElementsByTagName('script');
        for (var i = 0; i < ss.length; i++) { if (/bot-widget\.js(\?|$)/.test(ss[i].src)) { self = ss[i]; break; } }
    }
    function attr(n) { return self && self.getAttribute ? (self.getAttribute(n) || '') : ''; }
    var SLUG = attr('data-bot');
    if (!SLUG) { try { console.warn('[bot-widget] missing data-bot="<slug>" on the script tag.'); } catch (e) {} return; }
    var scriptSrc = (self && self.src) || '';
    var BASE = scriptSrc ? scriptSrc.replace(/\/bot-widget\.js(\?.*)?$/, '') : location.origin;
    var API = BASE + '/api/bot-chat';
    var ACCENT = attr('data-accent') || '#0b1220';
    var UID = 'ppbot-' + SLUG.replace(/[^a-z0-9]/gi, '') ;

    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function post(body) {
        return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ slug: SLUG }, body)) })
            .then(function (r) { return r.json(); }).catch(function () { return { success: false, message: 'Network error.' }; });
    }
    function visitorKey() {
        var k = 'ppbot_vk_' + SLUG;
        try {
            var v = sessionStorage.getItem(k);
            if (!v) { v = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem(k, v); }
            return v;
        } catch (e) { return 'v_' + Math.random().toString(36).slice(2); }
    }
    var VK = visitorKey();

    function injectCss() {
        var style = document.createElement('style');
        style.textContent =
            '#' + UID + '-launcher{position:fixed;bottom:20px;right:20px;width:58px;height:58px;border-radius:50%;background:' + ACCENT + ';color:#fff;border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:999998;display:flex;align-items:center;justify-content:center;font-size:26px;transition:transform .15s ease;}' +
            '#' + UID + '-launcher:hover{transform:scale(1.06);}' +
            '#' + UID + '-panel{position:fixed;bottom:88px;right:20px;width:min(360px,calc(100vw - 32px));height:min(520px,calc(100vh - 140px));background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
            '#' + UID + '-head{background:' + ACCENT + ';color:#fff;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex:none;}' +
            '#' + UID + '-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f8fafc;}' +
            '#' + UID + '-foot{flex:none;padding:10px;border-top:1px solid #e2e8f0;display:flex;gap:8px;background:#fff;}' +
            '.' + UID + '-bubble{max-width:82%;padding:9px 13px;border-radius:14px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;}' +
            '.' + UID + '-bubble.bot{background:#fff;border:1px solid #e2e8f0;color:#1e293b;align-self:flex-start;border-bottom-left-radius:4px;}' +
            '.' + UID + '-bubble.user{background:' + ACCENT + ';color:#fff;align-self:flex-end;border-bottom-right-radius:4px;}' +
            '.' + UID + '-bubble.typing{color:#94a3b8;font-style:italic;}' +
            '#' + UID + '-input{flex:1;border:1px solid #e2e8f0;border-radius:10px;padding:9px 12px;font-size:13.5px;font-family:inherit;outline:none;}' +
            '#' + UID + '-send{background:' + ACCENT + ';color:#fff;border:none;border-radius:10px;padding:0 16px;font-weight:700;cursor:pointer;font-size:13px;}';
        document.head.appendChild(style);
    }

    var panelOpen = false, botName = 'Assistant', started = false;

    function bubble(role, text) {
        var body = document.getElementById(UID + '-body');
        var div = document.createElement('div');
        div.className = UID + '-bubble ' + (role === 'user' ? 'user' : 'bot');
        div.textContent = text;
        body.appendChild(div);
        body.scrollTop = body.scrollHeight;
        return div;
    }

    function ensureStarted() {
        if (started) return;
        started = true;
        post({ action: 'config' }).then(function (r) {
            if (!r.success) { bubble('bot', r.message || 'This assistant is not available right now.'); return; }
            botName = r.bot.name || botName;
            var head = document.getElementById(UID + '-headname'); if (head) head.textContent = botName;
            bubble('bot', r.bot.welcome_message || ('Hi! I\'m ' + botName + '. How can I help?'));
        });
    }

    function send() {
        var input = document.getElementById(UID + '-input');
        var text = (input.value || '').trim();
        if (!text) return;
        input.value = '';
        bubble('user', text);
        var typing = bubble('bot', 'typing…'); typing.className += ' typing';
        post({ action: 'message', visitor_key: VK, text: text }).then(function (r) {
            typing.remove();
            bubble('bot', r.success ? r.reply : (r.message || 'Something went wrong — please try again.'));
        });
    }

    function toggle() {
        panelOpen = !panelOpen;
        document.getElementById(UID + '-panel').style.display = panelOpen ? 'flex' : 'none';
        if (panelOpen) { ensureStarted(); setTimeout(function () { var i = document.getElementById(UID + '-input'); if (i) i.focus(); }, 50); }
    }

    function render() {
        injectCss();
        var launcher = document.createElement('button');
        launcher.id = UID + '-launcher';
        launcher.type = 'button';
        launcher.setAttribute('aria-label', 'Chat with us');
        launcher.innerHTML = '💬';
        launcher.onclick = toggle;
        document.body.appendChild(launcher);

        var panel = document.createElement('div');
        panel.id = UID + '-panel';
        panel.innerHTML =
            '<div id="' + UID + '-head"><div style="font-weight:800;font-size:14px;" id="' + UID + '-headname">Assistant</div>' +
            '<button type="button" id="' + UID + '-close" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;">×</button></div>' +
            '<div id="' + UID + '-body"></div>' +
            '<div id="' + UID + '-foot"><input id="' + UID + '-input" placeholder="Type a message…"><button id="' + UID + '-send" type="button">Send</button></div>';
        document.body.appendChild(panel);

        document.getElementById(UID + '-close').onclick = toggle;
        document.getElementById(UID + '-send').onclick = send;
        document.getElementById(UID + '-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
    else render();
})();
