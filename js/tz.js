// Shared timezone-aware date formatting — reads pp_tz from localStorage.
// Populated at login from the business_profile API.
(function () {
    function tz() { return localStorage.getItem('pp_tz') || 'America/Chicago'; }

    window.fmtDate = function (d) {
        if (!d) return '—';
        try { return new Date(d).toLocaleDateString('en-US', { timeZone: tz(), month: 'short', day: 'numeric', year: 'numeric' }); }
        catch (e) { return new Date(d).toLocaleDateString(); }
    };

    window.fmtDateTime = function (d) {
        if (!d) return '—';
        try { return new Date(d).toLocaleString('en-US', { timeZone: tz(), month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return new Date(d).toLocaleString(); }
    };

    window.fmtTime = function (d) {
        if (!d) return '—';
        try { return new Date(d).toLocaleTimeString('en-US', { timeZone: tz(), hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return new Date(d).toLocaleTimeString(); }
    };
})();
