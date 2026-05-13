import { createClient } from '@supabase/supabase-js';

export async function validateSession(req) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.slice(7).trim();
    if (!token) return null;

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: session } = await supabase
        .from('staff_sessions')
        .select('userid, expires_at')
        .eq('session_token', token)
        .maybeSingle();

    if (!session) return null;

    if (new Date(session.expires_at) < new Date()) {
        await supabase.from('staff_sessions').delete().eq('session_token', token);
        return null;
    }

    // Refresh last_used (fire-and-forget)
    supabase.from('staff_sessions').update({ last_used: new Date().toISOString() }).eq('session_token', token);

    return { userid: session.userid };
}

export function sessionErrorResponse(res) {
    return res.status(401).json({
        success: false,
        message: 'Session expired. Please log in again.',
        reason: 'session_expired'
    });
}
