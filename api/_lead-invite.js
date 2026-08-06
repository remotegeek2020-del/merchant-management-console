// Shared "set up your account" invite for prospects (Lead Portal).
// Generates a single-use token, stores it, and emails a setup link (Postmark).
// Best-effort: returns true only if an email was actually sent.
import { ServerClient } from 'postmark';
import crypto from 'crypto';

export async function sendLeadInvite(supabase, lead, host) {
    if (!supabase || !lead || !lead.email) return false;
    const tok = crypto.randomBytes(32).toString('hex');
    await supabase.from('leads').update({ invite_token: tok, invite_sent_at: new Date().toISOString() }).eq('id', lead.id);
    if (!process.env.POSTMARK_SERVER_TOKEN || !process.env.EMAIL_FROM) return false;
    const link = `https://${host || 'portal.mypayprotec.com'}/lead/setup?token=${tok}`;
    const first = String(lead.full_name || '').trim().split(/\s+/)[0] || 'there';
    try {
        const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
        await client.sendEmail({
            From: process.env.EMAIL_FROM,
            To: lead.email,
            Subject: 'Set up your PayProTec Partner Program account',
            HtmlBody: `<div style="font-family:'DM Sans',Arial,sans-serif;max-width:520px;margin:auto;padding:30px;border:1px solid #e2e8f0;border-radius:16px;color:#0f172a;">
                <h2 style="color:#0d9488;margin:0 0 6px;">Welcome to the PayProTec Partner Program 🎉</h2>
                <p style="line-height:1.6;">Hi ${first}, you've been added to the PayProTec Partner Program. Set up your account to watch our webinars, keep up with announcements, and book your become-a-partner call.</p>
                <div style="text-align:center;margin:32px 0;"><a href="${link}" style="background:#0d9488;color:#fff;padding:14px 28px;text-decoration:none;border-radius:10px;font-weight:800;display:inline-block;">Set up my account</a></div>
                <p style="font-size:12px;color:#64748b;">Or paste this link into your browser:<br><a href="${link}" style="color:#0d9488;word-break:break-all;">${link}</a></p>
                <hr style="border:0;border-top:1px solid #f1f5f9;margin:28px 0;">
                <p style="font-size:11px;color:#94a3b8;text-align:center;">PayProTec Partner Program</p></div>`,
            TextBody: `Hi ${first}, set up your PayProTec Partner Program account: ${link}`,
            MessageStream: 'outbound'
        });
        return true;
    } catch (e) { return false; }
}
