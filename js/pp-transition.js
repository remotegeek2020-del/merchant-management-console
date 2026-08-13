// Smooth page transitions across the portal → agency → CRM flow.
//
// Uses the cross-document View Transitions API: when you navigate between two
// same-origin pages that BOTH opt in with `@view-transition { navigation: auto }`,
// the browser automatically crossfades the old page out and the new page in.
// No per-link wiring needed. Browsers without support simply navigate normally
// (graceful no-op), and reduced-motion users get no animation.
(function () {
    try {
        var s = document.createElement('style');
        s.setAttribute('data-pp-transition', '1');
        s.textContent =
            '@view-transition{navigation:auto;}'
            + '@keyframes pp-vt-in{from{opacity:0;transform:translateY(10px) scale(.995);}to{opacity:1;transform:none;}}'
            + '@keyframes pp-vt-out{from{opacity:1;transform:none;}to{opacity:0;transform:translateY(-6px) scale(.995);}}'
            + '::view-transition-old(root){animation:pp-vt-out .20s ease both;}'
            + '::view-transition-new(root){animation:pp-vt-in .30s ease both;}'
            + '@media (prefers-reduced-motion: reduce){::view-transition-old(root),::view-transition-new(root){animation:none;}}';
        (document.head || document.documentElement).appendChild(s);
    } catch (e) { /* transitions are best-effort */ }
})();
