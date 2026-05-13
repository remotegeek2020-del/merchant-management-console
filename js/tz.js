// Shared timezone-aware date formatting — reads pp_tz from localStorage.
// Populated at login from the business_profile API.
(function () {
    function tz() { return localStorage.getItem('pp_tz') || 'America/Chicago'; }

    // Date-only strings from the DB (YYYY-MM-DD) are parsed by JS as UTC midnight,
    // which shifts them one day back in negative-offset timezones. Treat them as
    // noon UTC instead so the displayed date always matches what was stored.
    function normalize(d) {
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d + 'T12:00:00Z';
        return d;
    }

    window.fmtDate = function (d) {
        if (!d) return '—';
        try { return new Date(normalize(d)).toLocaleDateString('en-US', { timeZone: tz(), month: 'short', day: 'numeric', year: 'numeric' }); }
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

    // Returns YYYY-MM-DD for <input type="date"> fields.
    // Date-only strings are already in the right format — return them directly.
    // For Date objects or timestamps, convert to the configured timezone.
    window.fmtDateInput = function (d) {
        if (!d) return '';
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
        try { return new Date(d).toLocaleDateString('en-CA', { timeZone: tz() }); }
        catch (e) { return new Date(d).toISOString().split('T')[0]; }
    };
})();
