// ── Website bot — staff admin API (Phase 1) ──────────────────────────────────
// CRUD for bots + their manually-fed knowledge chunks. Any authenticated
// staff member can use this (no extra role gate yet — tighten later if
// needed once this is a bigger surface with real reach).
import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { getConfigValue } from './api-config.js';
import { providerAuthUrl, providerDiagnostics, logProviderMessage } from './_bot-ghl-provider.js';
import * as webflow from './_webflow.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ok = (res, data = {}) => res.status(200).json({ success: true, data });
const bad = (res, message) => res.status(200).json({ success: false, message });
const str = (v, n) => (v == null ? '' : String(v)).slice(0, n);

function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
// The Webflow-side loader — a tiny bootstrap that pulls in the real widget,
// same pattern as the announcement system's embedLoaderSource.
function botLoaderSource(origin, slug, position) {
    const posAttr = position && position !== 'bottom-right' ? `s.setAttribute("data-position","${position}");` : '';
    return `(function(d){var s=d.createElement("script");s.src="${origin}/bot-widget.js";s.setAttribute("data-bot","${slug}");${posAttr}(d.body||d.head).appendChild(s);})(document);`;
}
function reqOrigin(req) {
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
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
        // Diagnose + actually fire a test message so staff can see the REAL
        // HighLevel response (not guess from Vercel logs) when "messages
        // aren't showing up in Conversations" is reported.
        if (action === 'provider_diagnostics') {
            return ok(res, await providerDiagnostics());
        }
        if (action === 'provider_test_message') {
            const contactId = String(body.contact_id || '').trim();
            if (!contactId) return bad(res, 'Paste a HighLevel Contact ID to test against.');
            const diag = await providerDiagnostics();
            // Test BOTH directions separately — if only one fails, that tells
            // us the direction flag itself (not the provider ID/type) is the
            // actual problem, instead of guessing from one combined result.
            const [inboundR, outboundR] = await Promise.all([
                logProviderMessage({ contactId, direction: 'inbound', body: '[PayProTec bot test message — inbound — safe to ignore]' }),
                logProviderMessage({ contactId, direction: 'outbound', body: '[PayProTec bot test message — outbound — safe to ignore]' })
            ]);
            return ok(res, { diagnostics: diag, inbound: inboundR, outbound: outboundR });
        }

        if (action === 'list_bots') {
            const { data } = await supabase.from('bots').select('*').order('created_at', { ascending: false });
            return ok(res, data || []);
        }

        // ── Webflow auto-embed (reuses the existing Webflow connection the
        // announcement system already set up — no separate OAuth needed) ──────
        if (action === 'list_webflow_sites') {
            const token = await webflow.getToken();
            const { data: sites } = await supabase.from('marketing_sites')
                .select('id, name, webflow_site_id').eq('provider', 'webflow').order('name');
            const { data: wirings } = await supabase.from('bot_webflow_sites').select('*').eq('bot_id', body.bot_id);
            const wiredBySite = Object.fromEntries((wirings || []).map(w => [w.site_id, w]));
            return ok(res, {
                app_configured: webflow.webflowConfigured(), connected: !!token,
                sites: (sites || []).map(s => ({ ...s, wiring: wiredBySite[s.id] || null }))
            });
        }
        if (action === 'wire_bot_webflow' || action === 'unwire_bot_webflow') {
            const { bot_id, site_id, position } = body;
            const { data: bot } = await supabase.from('bots').select('id, slug').eq('id', bot_id).maybeSingle();
            const { data: site } = await supabase.from('marketing_sites').select('*').eq('id', site_id).maybeSingle();
            if (!bot || !site || !site.webflow_site_id) return bad(res, 'Bot or Webflow site not found.');
            try {
                if (action === 'wire_bot_webflow') {
                    const src = botLoaderSource(reqOrigin(req), bot.slug, position || 'bottom-right');
                    // Webflow requires displayName to be strictly alphanumeric
                    // (no hyphens/underscores), unlike our slugs which use them.
                    const displayName = ('PPTBot' + bot.slug.replace(/[^a-zA-Z0-9]/g, '')).slice(0, 50) || 'PPTBot';
                    const scriptId = await webflow.ensureInlineScript(site.webflow_site_id, src, displayName, '1.0.0');
                    await webflow.applyFooterScript(site.webflow_site_id, scriptId, '1.0.0');
                    await webflow.publishSite(site.webflow_site_id);
                    await supabase.from('bot_webflow_sites').upsert({
                        bot_id, site_id, script_id: scriptId, position: position || 'bottom-right', wired: true
                    }, { onConflict: 'bot_id,site_id' });
                } else {
                    const { data: wiring } = await supabase.from('bot_webflow_sites').select('script_id').eq('bot_id', bot_id).eq('site_id', site_id).maybeSingle();
                    if (wiring && wiring.script_id) await webflow.removeFooterScript(site.webflow_site_id, wiring.script_id);
                    await webflow.publishSite(site.webflow_site_id);
                    await supabase.from('bot_webflow_sites').update({ wired: false }).eq('bot_id', bot_id).eq('site_id', site_id);
                }
            } catch (e) { return bad(res, e.message); }
            return ok(res, { ok: true });
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
                booking_style: ['link', 'auto_book'].includes(body.booking_style) ? body.booking_style : 'widget',
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
                booking_style: ['link', 'auto_book'].includes(body.booking_style) ? body.booking_style : 'widget',
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
