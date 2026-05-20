import { validateSession, sessionErrorResponse } from './_validate.js';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const POSTMARK_API = 'https://api.postmarkapp.com';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    if (req.method !== 'POST') return res.status(405).json({ success: false });

    const token = process.env.POSTMARK_SERVER_TOKEN;
    if (!token) return res.status(500).json({ success: false, message: 'POSTMARK_SERVER_TOKEN not configured' });

    res.setHeader('Content-Type', 'application/json');
    const { action, count = 50, offset = 0, recipient, subject, message_id } = req.body;

    const headers = {
        'Accept': 'application/json',
        'X-Postmark-Server-Token': token,
    };

    try {
        if (action === 'list') {
            const params = new URLSearchParams({ count, offset });
            if (recipient) params.set('recipient', recipient);
            if (subject)   params.set('subject',   subject);

            const r = await fetch(`${POSTMARK_API}/messages/outbound?${params}`, { headers });
            if (!r.ok) throw new Error(`Postmark API error: ${r.status}`);
            const data = await r.json();

            return res.status(200).json({
                success: true,
                total: data.TotalCount,
                messages: (data.Messages || []).map(m => ({
                    id:         m.MessageID,
                    subject:    m.Subject,
                    from:       m.From,
                    to:         m.Recipients?.join(', ') || '',
                    status:     m.Status,
                    sent_at:    m.ReceivedAt,
                    stream:     m.MessageStream,
                    tag:        m.Tag || null,
                }))
            });
        }

        if (action === 'detail') {
            if (!message_id) return res.status(400).json({ success: false, message: 'message_id required' });
            const r = await fetch(`${POSTMARK_API}/messages/outbound/${message_id}/details`, { headers });
            if (!r.ok) throw new Error(`Postmark API error: ${r.status}`);
            const data = await r.json();
            return res.status(200).json({ success: true, detail: data });
        }

        return res.status(400).json({ success: false, message: 'Unknown action' });
    } catch (err) {
        console.error('[email-log]', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
