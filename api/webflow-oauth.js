// Webflow OAuth callback. Webflow redirects here with ?code&state after the
// user authorizes the app. We verify state, exchange the code for a token
// (stored encrypted), then bounce back to /marketing.
import { getConfigValue, setConfigValue } from './api-config.js';
import { exchangeCode } from './_webflow.js';

function redirectMarketing(res, status) {
    res.writeHead(302, { Location: `/marketing?webflow=${status}` });
    res.end();
}

export default async function handler(req, res) {
    try {
        const { code, state, error } = req.query || {};
        if (error) return redirectMarketing(res, 'error');
        if (!code) return redirectMarketing(res, 'error');

        // Verify the state we stored when building the authorize URL, then
        // consume it so it can't be replayed (single-use nonce).
        const expected = await getConfigValue('WEBFLOW_OAUTH_STATE');
        if (!state || !expected || state !== expected) return redirectMarketing(res, 'state');
        await setConfigValue('WEBFLOW_OAUTH_STATE', '', 'webflow-oauth');

        const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const redirectUri = `${proto}://${host}/api/webflow-oauth`;

        await exchangeCode(code, redirectUri);
        return redirectMarketing(res, 'connected');
    } catch (e) {
        return redirectMarketing(res, 'error');
    }
}
