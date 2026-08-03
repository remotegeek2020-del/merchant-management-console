// Shared staff access-check helpers.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Load the acting staff user (or null).
export async function loadActor(userid) {
    if (!userid) return null;
    const { data } = await supabase.from('app_users')
        .select('userid, email, first_name, last_name, role, is_active, access_marketing, access_marketing_settings')
        .eq('userid', userid).maybeSingle();
    return data || null;
}

export function actorName(a) {
    if (!a) return '';
    return `${a.first_name || ''} ${a.last_name || ''}`.trim() || a.email || a.userid;
}

export function isAdminRole(a) {
    const r = String(a?.role || '').toLowerCase();
    return r.includes('super') || r.includes('admin');
}

// Broad marketing access (existing rule).
export function canMarketing(a) {
    return !!a && (a.is_active !== false) && (isAdminRole(a) || a.access_marketing === true);
}

// Granular Marketing → Settings access (integration keys / OAuth).
export function canMarketingSettings(a) {
    return !!a && (a.is_active !== false) && (isAdminRole(a) || a.access_marketing_settings === true);
}
