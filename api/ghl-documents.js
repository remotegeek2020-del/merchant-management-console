import { validateSession, sessionErrorResponse } from './_validate.js';
import { getConfigValue } from './api-config.js';

export const config = { api: { bodyParser: { sizeLimit: '25mb' } } };

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    res.setHeader('Content-Type', 'application/json');

    const { filename, mimetype, data: base64Data } = req.body || {};

    if (!filename || !base64Data) {
        return res.status(400).json({ success: false, message: 'Missing filename or file data.' });
    }

    const ghlApiKey = (await getConfigValue('GHL_API_KEY')) || process.env.GHL_API_KEY;
    const ghlLocationId = (await getConfigValue('GHL_LOCATION_ID')) || process.env.GHL_LOCATION_ID;
    if (!ghlApiKey) return res.status(500).json({ success: false, message: 'GHL not configured. Set API keys in Secret Dungeon → API Key Manager.' });

    try {
        const fileBuffer = Buffer.from(base64Data, 'base64');
        const blob = new Blob([fileBuffer], { type: mimetype || 'application/octet-stream' });
        const form = new FormData();
        form.append('file', blob, filename);
        if (ghlLocationId) form.append('locationId', ghlLocationId);

        const ghlRes = await fetch(`https://services.leadconnectorhq.com/medias/upload-file`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ghlApiKey}`,
                'Version': '2021-07-28'
            },
            body: form
        });

        if (!ghlRes.ok) {
            const errText = await ghlRes.text();
            console.error('[GHL Media Upload] HTTP', ghlRes.status, errText.slice(0, 500));
            return res.status(ghlRes.status).json({ success: false, message: `GHL error ${ghlRes.status}: ${errText.slice(0, 300)}` });
        }

        const ghlData = await ghlRes.json();
        return res.status(200).json({ success: true, document: ghlData.data || ghlData });
    } catch (err) {
        console.error('[GHL Media Upload Error]', err.message);
        return res.status(500).json({ success: false, message: 'Upload failed. Please try again.' });
    }
}
