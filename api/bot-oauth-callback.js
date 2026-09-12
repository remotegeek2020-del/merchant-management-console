// ── Website bot — OAuth callback for the HighLevel Custom Conversation Provider
// HighLevel redirects here after a staff member approves the Marketplace
// App install, with ?code=... This is a ONE-TIME setup step (visited via the
// "Connect HighLevel" link), not something visitors ever hit.
import { completeInstall } from './_bot-ghl-provider.js';

export default async function handler(req, res) {
    const code = req.query?.code;
    if (!code) return res.status(400).send('Missing ?code from HighLevel — this URL should only be reached via the HighLevel install/authorize redirect.');
    const r = await completeInstall(code, req);
    res.setHeader('Content-Type', 'text/html');
    if (!r.ok) {
        return res.status(200).send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
            <h2 style="color:#dc2626;">Connection failed</h2><p>${r.error || 'Unknown error'}</p>
            <p>Close this tab and try the "Connect HighLevel" link again.</p></body></html>`);
    }
    return res.status(200).send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2 style="color:#16a34a;">✓ Connected!</h2>
        <p>The website bot can now log conversations into HighLevel. You can close this tab.</p></body></html>`);
}
