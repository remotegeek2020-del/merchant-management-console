// Convert a YouTube watch / live / short / embed URL into an embeddable player
// URL (https://www.youtube.com/embed/<id>). Returns null when the URL isn't a
// recognizable YouTube link (so callers can fall back to a plain link/button).
export function ytEmbed(url, opts = {}) {
    const u = String(url == null ? '' : url).trim();
    if (!u) return null;
    let id = '';
    let m;
    if ((m = u.match(/[?&]v=([A-Za-z0-9_-]{6,})/))) id = m[1];
    else if ((m = u.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/))) id = m[1];
    else if ((m = u.match(/youtube\.com\/live\/([A-Za-z0-9_-]{6,})/))) id = m[1];
    else if ((m = u.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/))) id = m[1];
    else if ((m = u.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/))) id = m[1];
    if (!id) return null;
    const q = [];
    if (opts.autoplay) q.push('autoplay=1');
    if (opts.mute) q.push('mute=1');
    q.push('rel=0');
    return `https://www.youtube.com/embed/${id}` + (q.length ? ('?' + q.join('&')) : '');
}
