import { GoogleGenerativeAI } from "@google/generative-ai";
import { validateSession, sessionErrorResponse } from './_validate.js';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ answer: "Method not allowed." });

    const { query, userId, userName, lastResponse } = req.body;
    if (!query) return res.status(400).json({ answer: "No query provided." });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ answer: "GEMINI_API_KEY is not configured." });
    }

    // ── TOOL DEFINITIONS ──────────────────────────────────────────────────────
    const functionDeclarations = [

        // ── MERCHANTS ──────────────────────────────────────────────────────────
        {
            name: 'get_merchant_overview',
            description: 'Get a high-level merchant health summary: total active, suspended, at-risk count, average monthly volume, and top performers.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_merchants',
            description: 'Search merchants by business name (DBA) or merchant ID (MID). Returns status, volume, agent.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Name or MID to search for' },
                    limit: { type: 'number', description: 'Max results, default 10' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_merchant_detail',
            description: 'Get full profile for a specific merchant by MID string: status, volume trend, agent, open returns, active deployments.',
            parameters: {
                type: 'object',
                properties: {
                    merchant_id: { type: 'string', description: 'The merchant MID string' }
                },
                required: ['merchant_id']
            }
        },
        {
            name: 'get_at_risk_merchants',
            description: 'Get merchants whose 30-day processing volume has dropped 15%+ below their 90-day monthly baseline. Sorted by largest drop first.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max results, default 20' },
                    min_drop_pct: { type: 'number', description: 'Minimum drop % to include, default 15' }
                },
                required: []
            }
        },
        {
            name: 'get_merchants_by_status',
            description: 'Get merchants filtered by account status (Approved, Suspended, Terminated, Pending, PCI Non-Compliant, etc.).',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'Account status value' },
                    limit: { type: 'number', description: 'Max results, default 20' }
                },
                required: ['status']
            }
        },

        // ── PARTNERS ──────────────────────────────────────────────────────────
        {
            name: 'get_partner_overview',
            description: 'Get a summary of the partner network: total partners, how many have portal access, top partners by volume.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_partners',
            description: 'Search for partners (agents/reps) by name. Returns their merchant count, total volume, and portal status.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Partner name to search' },
                    limit: { type: 'number', description: 'Max results, default 10' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_partner_detail',
            description: 'Get detailed portfolio for a specific partner by their person_id: their merchants, volumes, at-risk merchants.',
            parameters: {
                type: 'object',
                properties: {
                    person_id: { type: 'string', description: 'The partner person UUID' }
                },
                required: ['person_id']
            }
        },
        {
            name: 'get_partners_without_portal',
            description: 'Get partners who have NOT yet been given portal access (is_portal_active is false).',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Max results, default 20' }
                },
                required: []
            }
        },

        // ── DEPLOYMENTS ────────────────────────────────────────────────────────
        {
            name: 'get_deployment_overview',
            description: 'Get deployment pipeline summary: count by status (Pending, In Progress, Delivered, Cancelled), recent activity.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'get_deployments',
            description: 'Get deployments filtered by status. Status options: Pending, In Progress, Delivered, Cancelled.',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'Deployment status filter, or omit for all recent' },
                    limit: { type: 'number', description: 'Max results, default 15' }
                },
                required: []
            }
        },

        // ── INVENTORY ──────────────────────────────────────────────────────────
        {
            name: 'get_inventory_overview',
            description: 'Get inventory health: total equipment count, stocked units, deployed units, units in repair, decommissioned count.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'search_inventory',
            description: 'Search inventory by serial number or terminal/device type.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Serial number or device type to search' },
                    limit: { type: 'number', description: 'Max results, default 15' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_inventory_by_location',
            description: 'Get equipment at a specific location. Locations: Warsaw Office, Warsaw Repairs, Merchant Site, In Transit.',
            parameters: {
                type: 'object',
                properties: {
                    location: { type: 'string', description: 'Location name' },
                    limit: { type: 'number', description: 'Max results, default 20' }
                },
                required: ['location']
            }
        },

        // ── RETURNS ────────────────────────────────────────────────────────────
        {
            name: 'get_returns_overview',
            description: 'Get returns summary: open count, pending count, defective rate, recent return activity.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        {
            name: 'get_returns',
            description: 'Get return requests filtered by status (Open, Pending, Completed, Cancelled).',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', description: 'Return status, or omit for open/pending' },
                    limit: { type: 'number', description: 'Max results, default 15' }
                },
                required: []
            }
        }
    ];

    // ── TOOL EXECUTOR ─────────────────────────────────────────────────────────
    async function executeTool(name, args) {
        try {
            switch (name) {

                // ── MERCHANTS ────────────────────────────────────────────────
                case 'get_merchant_overview': {
                    const [
                        { count: approved },
                        { count: suspended },
                        { count: terminated },
                        { count: pending },
                        { count: pciNonCompliant }
                    ] = await Promise.all([
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Approved'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Suspended'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Terminated'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Pending'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'PCI Non-Compliant')
                    ]);
                    // Top 5 by 30-day volume
                    const { data: topMerchants } = await supabase.from('merchants')
                        .select('dba_name, merchant_id, volume_30_day, agent_name')
                        .eq('account_status', 'Approved')
                        .order('volume_30_day', { ascending: false })
                        .limit(5);
                    // At-risk count
                    const { data: allActive } = await supabase.from('merchants')
                        .select('volume_30_day, volume_90_day')
                        .eq('account_status', 'Approved')
                        .gt('volume_90_day', 0);
                    const atRiskCount = (allActive || []).filter(m => {
                        const baseline = parseFloat(m.volume_90_day) / 3;
                        return baseline > 0 && (1 - parseFloat(m.volume_30_day) / baseline) >= 0.15;
                    }).length;
                    return { approved, suspended, terminated, pending, pci_non_compliant: pciNonCompliant, at_risk_count: atRiskCount, top_merchants_by_volume: topMerchants || [] };
                }

                case 'search_merchants': {
                    const limit = args.limit || 10;
                    const isNumeric = /^\d+$/.test(args.query);
                    let q = supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_name, merchant_state, last_batch_date')
                        .limit(limit);
                    if (isNumeric) q = q.ilike('merchant_id', `%${args.query}%`);
                    else q = q.ilike('dba_name', `%${args.query}%`);
                    const { data } = await q;
                    return { merchants: data || [], count: (data || []).length };
                }

                case 'get_merchant_detail': {
                    const { data: m } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_name, agent_id, merchant_phone, merchant_state, merchant_email, enrollment_date, last_batch_date')
                        .eq('merchant_id', args.merchant_id).single();
                    if (!m) return { error: 'Merchant not found' };
                    const baseline = m.volume_90_day ? parseFloat(m.volume_90_day) / 3 : 0;
                    const dropPct = baseline > 0 ? Math.round((1 - parseFloat(m.volume_30_day) / baseline) * 100) : 0;
                    const [{ data: deployments }, { data: returns_ }] = await Promise.all([
                        supabase.from('deployments').select('deployment_id, status, target_deployment_date, equipments:equipment_id(terminal_type, serial_number)').eq('merchant_id', m.merchant_id).order('target_deployment_date', { ascending: false }).limit(5),
                        supabase.from('returns').select('return_id, status, return_reason, created_at').eq('merchant_id', m.merchant_id).limit(5)
                    ]);
                    return { ...m, volume_baseline_monthly: Math.round(baseline), volume_drop_pct: dropPct, recent_deployments: deployments || [], recent_returns: returns_ || [] };
                }

                case 'get_at_risk_merchants': {
                    const limit = args.limit || 20;
                    const minDrop = args.min_drop_pct || 15;
                    const { data } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, volume_30_day, volume_90_day, agent_name, account_status, merchant_state')
                        .eq('account_status', 'Approved').gt('volume_90_day', 0).limit(500);
                    const atRisk = (data || [])
                        .map(m => {
                            const baseline = parseFloat(m.volume_90_day) / 3;
                            if (!baseline) return null;
                            const drop = Math.round((1 - parseFloat(m.volume_30_day) / baseline) * 100);
                            if (drop < minDrop) return null;
                            return { ...m, drop_pct: drop, baseline_monthly: Math.round(baseline) };
                        })
                        .filter(Boolean)
                        .sort((a, b) => b.drop_pct - a.drop_pct)
                        .slice(0, limit);
                    return { at_risk: atRisk, count: atRisk.length };
                }

                case 'get_merchants_by_status': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, agent_name, merchant_state, enrollment_date')
                        .eq('account_status', args.status)
                        .order('dba_name').limit(limit);
                    return { merchants: data || [], count: (data || []).length, status: args.status };
                }

                // ── PARTNERS ──────────────────────────────────────────────────
                case 'get_partner_overview': {
                    const [
                        { count: totalPartners },
                        { count: portalActive },
                        { count: portalSetup }
                    ] = await Promise.all([
                        supabase.from('persons').select('*', { count: 'exact', head: true }),
                        supabase.from('persons').select('*', { count: 'exact', head: true }).eq('is_portal_active', true),
                        supabase.from('persons').select('*', { count: 'exact', head: true }).eq('portal_password_set', true)
                    ]);
                    // Top partners by merchant volume
                    const { data: stats } = await supabase.from('agent_stats')
                        .select('agent_id, merchant_count, total_volume_sum')
                        .order('total_volume_sum', { ascending: false }).limit(5);
                    return { total_partners: totalPartners, portal_invited: portalActive, portal_fully_setup: portalSetup, top_partners_by_volume: stats || [] };
                }

                case 'search_partners': {
                    const limit = args.limit || 10;
                    const { data: persons } = await supabase.from('persons')
                        .select('id, full_name, email, is_portal_active, portal_password_set, enrolled_at')
                        .ilike('full_name', `%${args.query}%`).limit(limit);
                    if (!persons?.length) return { partners: [], count: 0 };
                    const personIds = persons.map(p => p.id);
                    const { data: agents } = await supabase.from('agents').select('id, parent_agent_id').in('parent_agent_id', personIds);
                    const agentIds = (agents || []).map(a => a.id);
                    const { data: stats } = agentIds.length
                        ? await supabase.from('agent_stats').select('agent_id, merchant_count, total_volume_sum').in('agent_id', agentIds)
                        : { data: [] };
                    const partners = persons.map(p => {
                        const myAgentIds = (agents || []).filter(a => a.parent_agent_id === p.id).map(a => a.id);
                        const myStats = (stats || []).filter(s => myAgentIds.includes(s.agent_id));
                        const totalVolume = myStats.reduce((sum, s) => sum + (parseFloat(s.total_volume_sum) || 0), 0);
                        const merchantCount = myStats.reduce((sum, s) => sum + (s.merchant_count || 0), 0);
                        return { ...p, merchant_count: merchantCount, total_volume: Math.round(totalVolume) };
                    });
                    return { partners, count: partners.length };
                }

                case 'get_partner_detail': {
                    const { data: person } = await supabase.from('persons')
                        .select('id, full_name, email, is_portal_active, portal_password_set, enrolled_at')
                        .eq('id', args.person_id).single();
                    if (!person) return { error: 'Partner not found' };
                    const { data: agents } = await supabase.from('agents').select('id').eq('parent_agent_id', args.person_id);
                    if (!agents?.length) return { ...person, merchants: [], at_risk: [] };
                    const agentIds = agents.map(a => a.id);
                    const { data: identifiers } = await supabase.from('agent_identifiers').select('id_string').in('agent_id', agentIds);
                    const agentIdStrings = (identifiers || []).map(i => i.id_string);
                    if (!agentIdStrings.length) return { ...person, merchants: [], at_risk: [] };
                    const { data: merchants } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day')
                        .in('agent_id', agentIdStrings).limit(50);
                    const atRisk = (merchants || []).filter(m => {
                        const baseline = parseFloat(m.volume_90_day) / 3;
                        return baseline > 0 && (1 - parseFloat(m.volume_30_day) / baseline) >= 0.15;
                    }).map(m => ({ dba_name: m.dba_name, merchant_id: m.merchant_id, drop_pct: Math.round((1 - parseFloat(m.volume_30_day) / (parseFloat(m.volume_90_day) / 3)) * 100) }));
                    return { ...person, total_merchants: (merchants || []).length, merchants: (merchants || []).slice(0, 10), at_risk_merchants: atRisk };
                }

                case 'get_partners_without_portal': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('persons')
                        .select('id, full_name, email, enrolled_at')
                        .eq('is_portal_active', false)
                        .order('enrolled_at', { ascending: false })
                        .limit(limit);
                    return { partners: data || [], count: (data || []).length };
                }

                // ── DEPLOYMENTS ────────────────────────────────────────────────
                case 'get_deployment_overview': {
                    const statuses = ['Pending', 'In Progress', 'Delivered', 'Cancelled'];
                    const counts = await Promise.all(statuses.map(s =>
                        supabase.from('deployments').select('*', { count: 'exact', head: true }).eq('status', s)
                    ));
                    const result = {};
                    statuses.forEach((s, i) => { result[s.toLowerCase().replace(' ', '_')] = counts[i].count || 0; });
                    // Overdue (pending past target date)
                    const { count: overdue } = await supabase.from('deployments')
                        .select('*', { count: 'exact', head: true })
                        .eq('status', 'Pending')
                        .lt('target_deployment_date', new Date().toISOString());
                    result.overdue_pending = overdue || 0;
                    return result;
                }

                case 'get_deployments': {
                    const limit = args.limit || 15;
                    let q = supabase.from('deployments')
                        .select('deployment_id, status, target_deployment_date, purchase_type, merchants:merchant_id(dba_name, merchant_id), equipments:equipment_id(terminal_type, serial_number)')
                        .order('target_deployment_date', { ascending: false })
                        .limit(limit);
                    if (args.status) q = q.eq('status', args.status);
                    const { data } = await q;
                    return { deployments: data || [], count: (data || []).length };
                }

                // ── INVENTORY ──────────────────────────────────────────────────
                case 'get_inventory_overview': {
                    const [
                        { count: total },
                        { count: stocked },
                        { count: deployed },
                        { count: inRepair },
                        { count: decommissioned }
                    ] = await Promise.all([
                        supabase.from('equipments').select('*', { count: 'exact', head: true }),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'stocked').eq('current_location', 'Warsaw Office'),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'deployed'),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('current_location', 'Warsaw Repairs'),
                        supabase.from('equipments').select('*', { count: 'exact', head: true }).eq('status', 'decommissioned')
                    ]);
                    // Breakdown by terminal type (stocked)
                    const { data: byType } = await supabase.from('equipments')
                        .select('terminal_type')
                        .eq('status', 'stocked');
                    const typeBreakdown = {};
                    (byType || []).forEach(e => {
                        const t = e.terminal_type || 'Unknown';
                        typeBreakdown[t] = (typeBreakdown[t] || 0) + 1;
                    });
                    return { total, stocked, deployed, in_repair: inRepair, decommissioned, stocked_by_type: typeBreakdown };
                }

                case 'search_inventory': {
                    const limit = args.limit || 15;
                    const { data } = await supabase.from('equipments')
                        .select('id, serial_number, terminal_type, status, current_location, condition, received_date')
                        .or(`serial_number.ilike.%${args.query}%,terminal_type.ilike.%${args.query}%`)
                        .limit(limit);
                    return { equipment: data || [], count: (data || []).length };
                }

                case 'get_inventory_by_location': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('equipments')
                        .select('id, serial_number, terminal_type, status, condition, received_date')
                        .ilike('current_location', `%${args.location}%`)
                        .limit(limit);
                    return { equipment: data || [], count: (data || []).length, location: args.location };
                }

                // ── RETURNS ────────────────────────────────────────────────────
                case 'get_returns_overview': {
                    const [
                        { count: open },
                        { count: pending },
                        { count: completed },
                        { count: defective }
                    ] = await Promise.all([
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('status', 'open'),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('status', 'pending'),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('status', 'completed'),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).ilike('condition', '%defective%')
                    ]);
                    const { data: recent } = await supabase.from('returns')
                        .select('return_id, merchant_name, status, return_reason, created_at')
                        .order('created_at', { ascending: false }).limit(5);
                    return { open, pending, completed, defective_units: defective, recent: recent || [] };
                }

                case 'get_returns': {
                    const limit = args.limit || 15;
                    let q = supabase.from('returns')
                        .select('id, return_id, merchant_name, merchant_id, status, return_reason, condition, destination, created_at')
                        .order('created_at', { ascending: false })
                        .limit(limit);
                    if (args.status) q = q.ilike('status', args.status);
                    else q = q.or('status.ilike.open,status.ilike.pending');
                    const { data } = await q;
                    return { returns: data || [], count: (data || []).length };
                }

                default:
                    return { error: `Unknown tool: ${name}` };
            }
        } catch (e) {
            console.error(`[Jarvis Tool Error] ${name}:`, e.message);
            return { error: e.message };
        }
    }

    try {

        // ── LOAD KNOWLEDGE BASE ───────────────────────────────────────────────
        const { data: knowledgeRows } = await supabase
            .from('jarvis_knowledge')
            .select('topic, correct_logic')
            .order('created_at', { ascending: false })
            .limit(40);

        const knowledgeBlock = (knowledgeRows || []).length > 0
            ? '\n\nINTERNAL KNOWLEDGE BASE (always apply these rules and facts):\n' +
              (knowledgeRows || []).map(k => `• [${k.topic}] ${k.correct_logic}`).join('\n')
            : '';

        // ── CHAT HISTORY ──────────────────────────────────────────────────────
        const { data: history } = await supabase
            .from('chat_history')
            .select('role, content')
            .eq('userid', userId)
            .order('created_at', { ascending: false })
            .limit(12);

        const formattedHistory = (history || []).map(h => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: h.content }]
        })).reverse();

        // ── SYSTEM PROMPT ─────────────────────────────────────────────────────
        const systemInstruction = `You are JARVIS, the AI business intelligence agent for PayProTec's merchant management console. Address the user as ${userName || 'Sir'}.

Your focus areas: Merchants, Partners, Deployments, Inventory, and Returns. You have live database access via tools.

CRITICAL CONVERSATION RULES:
1. Always read the full conversation history before deciding what to do.
2. For follow-up questions ("review it", "what about that merchant", "tell me more", "can you analyze it"), use the data already retrieved in previous messages — do NOT call tools again or ask "what would you like to review?" You already have the context.
3. Pronouns like "it", "that", "this merchant", "the above" always refer to the most recently discussed subject in the conversation history.
4. Only call tools when genuinely NEW data is needed (e.g. a different merchant, a new topic, or refreshing stale data).
5. For greetings or fully off-topic messages, respond briefly.
6. End substantive answers with "**Suggested Actions:**" listing 2-4 concrete next steps.

TOOL USAGE:
- Call tools for fresh data lookups
- Do NOT call tools when you already have the data from this conversation

Formatting: use **bold** for names/numbers, bullet lists for items, keep responses concise.

NAVIGATION ACTIONS — when suggesting a page to visit, use EXACTLY these URL formats (never invent paths):
- Merchant list: → View all merchants (url:/merchants-dashboard.html)
- Search merchants by name: → Search for [name] in merchants (url:/merchants-dashboard.html?q=[name])
- Filter merchants by status: → View [status] merchants (url:/merchants-dashboard.html?filterBy=[status])
- Partners list: → View all partners (url:/partners-dashboard.html)
- Search partners: → Search for [name] in partners (url:/partners-dashboard.html?q=[name])
- Deployments: → View deployments (url:/deployments-dashboard.html)
- Search deployments: → Search deployments (url:/deployments-dashboard.html?q=[term])
- Inventory/Equipment: → View inventory (url:/equipments-dashboard.html)
- Search inventory: → Search inventory (url:/equipments-dashboard.html?q=[term])
- Returns: → View returns (url:/returns-dashboard.html)
- Search returns: → Search returns (url:/returns-dashboard.html?q=[term])
Only include navigation actions when they are genuinely useful. Use real names/values in the URL query params, not placeholder text like [name].` + knowledgeBlock;

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

        // ── FOLLOW-UP DETECTION ───────────────────────────────────────────────
        // lastResponse comes directly from the frontend (in-memory), so it's
        // always reliable regardless of DB state or userId issues.
        const followUpWords = /\b(it|that|this|them|the above|the merchant|the partner|the same|the one)\b/i;
        const followUpPhrases = /^(review|analyze|summarize|tell me more|what about|explain|more detail|give me|show me more|what'?s? the|how about|can you|what do you think|is that|are they|why is|who is)/i;
        const isFollowUp = query.trim().length < 150 && (followUpWords.test(query) || followUpPhrases.test(query.trim()));

        const hasLastResponse = !!(lastResponse && lastResponse.trim().length > 50);

        const toolCallsLog = [];
        let finalAnswer;

        if (isFollowUp && hasLastResponse) {
            // ── FOLLOW-UP PATH: no tools, answer from prior context ────────────
            // Uses a separate model instance with NO tools — Gemini cannot call
            // tools when they're not registered on the model instance.
            const prevResponse = lastResponse.slice(0, 2000);
            const followUpModel = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction: `You are JARVIS, a business intelligence assistant for PayProTec. Address the user as ${userName || 'Sir'}. You are answering a follow-up question about data that was already retrieved. Use only the previous response provided as context — do not say you need more information or ask what they want to review. Give a direct, analytical answer. Use **bold** for key data points. End with "**Suggested Actions:**" listing 2-3 concrete next steps.`
            });
            const r = await followUpModel.generateContent(
                `Previous JARVIS response containing the relevant data:\n"""\n${prevResponse}\n"""\n\nUser follow-up: ${query}\n\nAnswer directly and analytically. If they ask for a review or analysis, assess the merchant/partner/data from the previous response — comment on status, volume trends, risks, and what actions should be taken.`
            );
            try { finalAnswer = r.response.text(); }
            catch { finalAnswer = 'Could not generate follow-up response. Please try rephrasing.'; }

        } else {
            // ── MAIN PATH: full agentic loop with tools ────────────────────────
            const model = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                systemInstruction,
                tools: [{ functionDeclarations }]
            });
            const chat = model.startChat({ history: formattedHistory });
            let result = await chat.sendMessage(query);
            let maxIterations = 8;

            while (maxIterations-- > 0) {
                let calls;
                try { calls = result.response.functionCalls(); } catch { calls = null; }
                if (!calls || calls.length === 0) break;
                const toolResponses = [];
                for (const call of calls) {
                    toolCallsLog.push(call.name);
                    const toolResult = await executeTool(call.name, call.args || {});
                    toolResponses.push({ functionResponse: { name: call.name, response: toolResult } });
                }
                result = await chat.sendMessage(toolResponses);
            }
            try { finalAnswer = result.response.text(); }
            catch { finalAnswer = 'I encountered an issue generating a response. Please try again.'; }
        }

        // ── EXTRACT NAVIGATION SUGGESTIONS ────────────────────────────────────
        const suggestions = [];
        const urlMatches = [...finalAnswer.matchAll(/→\s*([^\n(]+)\(url:([^)]+)\)/g)];
        for (const m of urlMatches) {
            suggestions.push({ label: m[1].trim().replace(/\*\*/g, ''), url: m[2].trim() });
        }
        const cleanAnswer = finalAnswer.replace(/\s*\(url:[^)]+\)/g, '');

        // ── PERSIST HISTORY ───────────────────────────────────────────────────
        try {
            await supabase.from('chat_history').insert([
                { userid: userId, role: 'user', content: query },
                { userid: userId, role: 'assistant', content: cleanAnswer }
            ]);
        } catch { /* non-fatal */ }

        return res.status(200).json({
            answer: cleanAnswer,
            suggestions,
            tools_used: [...new Set(toolCallsLog)]
        });

    } catch (err) {
        console.error('[Jarvis Error]', err?.message || err);
        return res.status(200).json({
            answer: `I hit an error, ${userName || 'Sir'}: ${err?.message || 'Unknown error'}. Please check the server logs.`,
            suggestions: [],
            tools_used: []
        });
    }
}
