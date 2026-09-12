// ── Website bot — staff admin API (Phase 1) ──────────────────────────────────
// CRUD for bots + their manually-fed knowledge chunks. Any authenticated
// staff member can use this (no extra role gate yet — tighten later if
// needed once this is a bigger surface with real reach).
import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { getConfigValue } from './api-config.js';
import { providerAuthUrl } from './_bot-ghl-provider.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ok = (res, data = {}) => res.status(200).json({ success: true, data });
const bad = (res, message) => res.status(200).json({ success: false, message });
const str = (v, n) => (v == null ? '' : String(v)).slice(0, n);

function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);
    res.setHeader('Content-Type', 'application/json');

    const body = req.body || {};
    const action = body.action;

    try {
        if (action === 'provider_status') {
            const configured = !!(await getConfigValue('GHL_BOT_CLIENT_ID')) && !!(await getConfigValue('GHL_BOT_CLIENT_SECRET')) && !!(await getConfigValue('GHL_BOT_CONVO_PROVIDER_ID'));
            const connected = !!(await getConfigValue('GHL_BOT_PROVIDER_TOKENS'));
            return ok(res, { configured, connected });
        }
        if (action === 'provider_connect_url') {
            const url = await providerAuthUrl(req);
            if (!url) return bad(res, 'Add GHL_BOT_CLIENT_ID in Secret Dungeon → API Manager first.');
            return ok(res, { url });
        }

        if (action === 'list_bots') {
            const { data } = await supabase.from('bots').select('*').order('created_at', { ascending: false });
            return ok(res, data || []);
        }

        if (action === 'get_bot') {
            const { data: bot } = await supabase.from('bots').select('*').eq('id', body.id).maybeSingle();
            if (!bot) return bad(res, 'Not found');
            const { data: knowledge } = await supabase.from('bot_knowledge').select('*').eq('bot_id', body.id).order('created_at', { ascending: false });
            return ok(res, { bot, knowledge: knowledge || [] });
        }

        if (action === 'create_bot') {
            const name = str(body.name, 200).trim();
            if (!name) return bad(res, 'Name is required.');
            let slug = slugify(body.slug || name);
            if (!slug) return bad(res, 'Could not derive a slug from that name — try adding letters/numbers.');
            const { data: existing } = await supabase.from('bots').select('id').eq('slug', slug).maybeSingle();
            if (existing) slug = slug + '-' + Math.random().toString(36).slice(2, 6);
            const { data, error } = await supabase.from('bots').insert({
                name, slug, persona: str(body.persona, 8000) || null,
                welcome_message: str(body.welcome_message, 500) || null,
                photo_url: str(body.photo_url, 1000) || null,
                is_active: body.is_active !== false, created_by: session.userid,
                ghl_location_id: str(body.ghl_location_id, 100) || null,
                prime49_min_volume: Number.isFinite(+body.prime49_min_volume) ? +body.prime49_min_volume : 20000,
                prime49_max_volume: Number.isFinite(+body.prime49_max_volume) ? +body.prime49_max_volume : 30000,
                booking_mode: body.booking_mode === 'form' ? 'form' : 'calendar',
                booking_calendar_id: str(body.booking_calendar_id, 100) || null,
                booking_calendar_name: str(body.booking_calendar_name, 200) || null,
                booking_form_id: str(body.booking_form_id, 100) || null,
                booking_form_name: str(body.booking_form_name, 200) || null,
                followup_enabled: !!body.followup_enabled,
                followup_hours: Number.isFinite(+body.followup_hours) && +body.followup_hours > 0 ? +body.followup_hours : 24,
                followup_message: str(body.followup_message, 500) || null
            }).select('*').single();
            if (error) return bad(res, error.message);
            return ok(res, data);
        }

        if (action === 'update_bot') {
            if (!body.id) return bad(res, 'Missing id.');
            const upd = {
                name: str(body.name, 200) || null,
                persona: str(body.persona, 8000) || null,
                welcome_message: str(body.welcome_message, 500) || null,
                photo_url: str(body.photo_url, 1000) || null,
                is_active: !!body.is_active,
                ghl_location_id: str(body.ghl_location_id, 100) || null,
                prime49_min_volume: Number.isFinite(+body.prime49_min_volume) ? +body.prime49_min_volume : 20000,
                prime49_max_volume: Number.isFinite(+body.prime49_max_volume) ? +body.prime49_max_volume : 30000,
                booking_mode: body.booking_mode === 'form' ? 'form' : 'calendar',
                booking_calendar_id: str(body.booking_calendar_id, 100) || null,
                booking_calendar_name: str(body.booking_calendar_name, 200) || null,
                booking_form_id: str(body.booking_form_id, 100) || null,
                booking_form_name: str(body.booking_form_name, 200) || null,
                followup_enabled: !!body.followup_enabled,
                followup_hours: Number.isFinite(+body.followup_hours) && +body.followup_hours > 0 ? +body.followup_hours : 24,
                followup_message: str(body.followup_message, 500) || null,
                updated_at: new Date().toISOString()
            };
            if (body.slug) {
                const slug = slugify(body.slug);
                const { data: existing } = await supabase.from('bots').select('id').eq('slug', slug).neq('id', body.id).maybeSingle();
                if (existing) return bad(res, 'That slug is already used by another bot.');
                upd.slug = slug;
            }
            const { error } = await supabase.from('bots').update(upd).eq('id', body.id);
            if (error) return bad(res, error.message);
            return ok(res, {});
        }

        if (action === 'delete_bot') {
            if (!body.id) return bad(res, 'Missing id.');
            await supabase.from('bots').delete().eq('id', body.id);
            return ok(res, {});
        }

        if (action === 'add_knowledge') {
            if (!body.bot_id) return bad(res, 'Missing bot_id.');
            const content = str(body.content, 8000).trim();
            if (!content) return bad(res, 'Content is required.');
            const { data, error } = await supabase.from('bot_knowledge').insert({
                bot_id: body.bot_id, topic: str(body.topic, 200) || null, content, source: 'manual'
            }).select('*').single();
            if (error) return bad(res, error.message);
            return ok(res, data);
        }

        if (action === 'delete_knowledge') {
            if (!body.id) return bad(res, 'Missing id.');
            await supabase.from('bot_knowledge').delete().eq('id', body.id);
            return ok(res, {});
        }

        return bad(res, 'Unknown action');
    } catch (e) {
        console.error('[bot-admin]', e.message);
        return bad(res, 'An unexpected error occurred.');
    }
}
