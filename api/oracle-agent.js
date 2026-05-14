import { GoogleGenerativeAI } from "@google/generative-ai";
import { validateSession, sessionErrorResponse } from './_validate.js';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).json({ answer: "Method not allowed." });

    const { query, userId, userName } = req.body;
    if (!query) return res.status(400).json({ answer: "No query provided." });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ answer: "GEMINI_API_KEY is not configured." });
    }

    // ── TOOL DEFINITIONS ──────────────────────────────────────────────────────
    const functionDeclarations = [
        {
            name: 'get_dashboard_summary',
            description: 'Get a high-level business overview: counts of open tickets, pending returns, pending tasks, recent deployments, and total active merchants.',
            parameters: { type: 'OBJECT', properties: {}, required: [] }
        },
        {
            name: 'search_merchants',
            description: 'Search for merchants by business name (DBA) or merchant ID (MID). Returns status, volume, agent info.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    query: { type: 'STRING', description: 'Name or MID to search for' },
                    limit: { type: 'NUMBER', description: 'Max results, default 10' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_at_risk_merchants',
            description: 'Get merchants whose 30-day volume has dropped 15%+ below their 90-day baseline. Returns name, drop%, volume, and agent.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    limit: { type: 'NUMBER', description: 'Max results, default 20' }
                },
                required: []
            }
        },
        {
            name: 'get_open_tickets',
            description: 'Get open or in-progress support tickets. Can filter by status.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    status: { type: 'STRING', description: 'Filter: open, in_progress, pending_partner, or omit for all active' },
                    limit: { type: 'NUMBER', description: 'Max results, default 15' }
                },
                required: []
            }
        },
        {
            name: 'get_pending_tasks',
            description: 'Get pending or overdue merchant tasks across the system.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    priority: { type: 'STRING', description: 'Filter: critical, high, medium, low' },
                    limit: { type: 'NUMBER', description: 'Max results, default 15' }
                },
                required: []
            }
        },
        {
            name: 'get_open_returns',
            description: 'Get recent open or pending return requests.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    limit: { type: 'NUMBER', description: 'Max results, default 15' }
                },
                required: []
            }
        },
        {
            name: 'get_recent_deployments',
            description: 'Get recent equipment deployments and their statuses.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    limit: { type: 'NUMBER', description: 'Max results, default 10' }
                },
                required: []
            }
        },
        {
            name: 'get_merchant_detail',
            description: 'Get detailed profile for a specific merchant by their merchant_id string (MID).',
            parameters: {
                type: 'OBJECT',
                properties: {
                    merchant_id: { type: 'STRING', description: 'The merchant MID string' }
                },
                required: ['merchant_id']
            }
        }
    ];

    // ── TOOL EXECUTOR ─────────────────────────────────────────────────────────
    async function executeTool(name, args) {
        try {
            switch (name) {

                case 'get_dashboard_summary': {
                    const [
                        { count: openTickets },
                        { count: pendingReturns },
                        { count: pendingTasks },
                        { count: activeDeployments },
                        { count: activeM }
                    ] = await Promise.all([
                        supabase.from('support_tickets').select('*', { count: 'exact', head: true }).in('status', ['open', 'in_progress', 'pending_partner']),
                        supabase.from('returns').select('*', { count: 'exact', head: true }).eq('status', 'Open'),
                        supabase.from('merchant_tasks').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
                        supabase.from('deployments').select('*', { count: 'exact', head: true }).eq('status', 'In Progress'),
                        supabase.from('merchants').select('*', { count: 'exact', head: true }).eq('account_status', 'Approved')
                    ]);
                    return { open_tickets: openTickets || 0, pending_returns: pendingReturns || 0, pending_tasks: pendingTasks || 0, active_deployments: activeDeployments || 0, active_merchants: activeM || 0 };
                }

                case 'search_merchants': {
                    const limit = args.limit || 10;
                    const isNumeric = /^\d+$/.test(args.query);
                    let q = supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_name, agent_id, merchant_phone, merchant_state')
                        .limit(limit);
                    if (isNumeric) q = q.ilike('merchant_id', `%${args.query}%`);
                    else q = q.ilike('dba_name', `%${args.query}%`);
                    const { data } = await q;
                    return { merchants: data || [], count: (data || []).length };
                }

                case 'get_merchant_detail': {
                    const { data } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, account_status, volume_30_day, volume_90_day, agent_name, agent_id, merchant_phone, merchant_state, merchant_email, enrollment_date, last_batch_date')
                        .eq('merchant_id', args.merchant_id)
                        .single();
                    if (!data) return { error: 'Merchant not found' };
                    const { data: tasks } = await supabase.from('merchant_tasks')
                        .select('title, status, priority, due_date')
                        .eq('merchant_id', data.id)
                        .eq('status', 'pending')
                        .limit(5);
                    const { data: tickets } = await supabase.from('support_tickets')
                        .select('ticket_number, subject, status, priority')
                        .eq('merchant_id', data.merchant_id)
                        .in('status', ['open', 'in_progress'])
                        .limit(5);
                    return { ...data, pending_tasks: tasks || [], open_tickets: tickets || [] };
                }

                case 'get_at_risk_merchants': {
                    const limit = args.limit || 20;
                    const { data } = await supabase.from('merchants')
                        .select('merchant_id, dba_name, volume_30_day, volume_90_day, agent_name, account_status')
                        .eq('account_status', 'Approved')
                        .gt('volume_90_day', 0)
                        .limit(200);
                    const atRisk = (data || [])
                        .map(m => {
                            const baseline = parseFloat(m.volume_90_day) / 3;
                            if (!baseline) return null;
                            const drop = Math.round((1 - parseFloat(m.volume_30_day) / baseline) * 100);
                            if (drop < 15) return null;
                            return { ...m, drop_pct: drop, baseline: Math.round(baseline) };
                        })
                        .filter(Boolean)
                        .sort((a, b) => b.drop_pct - a.drop_pct)
                        .slice(0, limit);
                    return { at_risk: atRisk, count: atRisk.length };
                }

                case 'get_open_tickets': {
                    const limit = args.limit || 15;
                    let q = supabase.from('support_tickets')
                        .select('id, ticket_number, subject, status, priority, created_at, merchants(dba_name)')
                        .order('created_at', { ascending: false })
                        .limit(limit);
                    if (args.status) q = q.eq('status', args.status);
                    else q = q.in('status', ['open', 'in_progress', 'pending_partner']);
                    const { data } = await q;
                    return { tickets: data || [], count: (data || []).length };
                }

                case 'get_pending_tasks': {
                    const limit = args.limit || 15;
                    let q = supabase.from('merchant_tasks')
                        .select('id, title, status, priority, due_date, created_at, merchants:merchant_id(dba_name, merchant_id)')
                        .eq('status', 'pending')
                        .order('priority', { ascending: false })
                        .order('due_date', { ascending: true })
                        .limit(limit);
                    if (args.priority) q = q.eq('priority', args.priority);
                    const { data } = await q;
                    const now = new Date();
                    const tasksWithOverdue = (data || []).map(t => ({
                        ...t,
                        overdue: t.due_date ? new Date(t.due_date) < now : false
                    }));
                    return { tasks: tasksWithOverdue, count: tasksWithOverdue.length };
                }

                case 'get_open_returns': {
                    const limit = args.limit || 15;
                    const { data } = await supabase.from('returns')
                        .select('id, merchant_name, merchant_id, status, reason, created_at, amount')
                        .in('status', ['Open', 'Pending'])
                        .order('created_at', { ascending: false })
                        .limit(limit);
                    return { returns: data || [], count: (data || []).length };
                }

                case 'get_recent_deployments': {
                    const limit = args.limit || 10;
                    const { data } = await supabase.from('deployments')
                        .select('id, merchant_name, merchant_id, status, device_type, created_at, tracking_number')
                        .order('created_at', { ascending: false })
                        .limit(limit);
                    return { deployments: data || [], count: (data || []).length };
                }

                default:
                    return { error: `Unknown tool: ${name}` };
            }
        } catch (e) {
            console.error(`[Jarvis Tool Error] ${name}:`, e.message);
            return { error: e.message };
        }
    }

    // ── CHAT HISTORY ──────────────────────────────────────────────────────────
    const { data: history } = await supabase
        .from('chat_history')
        .select('role, content')
        .eq('userid', userId)
        .order('created_at', { ascending: false })
        .limit(8);

    const formattedHistory = (history || []).map(h => ({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: h.content }]
    })).reverse();

    // ── SYSTEM PROMPT ─────────────────────────────────────────────────────────
    const systemInstruction = `You are JARVIS, the AI business intelligence agent for PayProTec's merchant management console. You address the user as ${userName || 'Sir'}.

Your role is to analyze business data and provide actionable intelligence — not just retrieve data. Always:
1. Use tools to gather relevant data before answering (don't guess)
2. Cross-reference multiple data sources when relevant (e.g. if a merchant is at-risk, also check their open tasks and tickets)
3. Provide a concise, insightful analysis — not just a raw list
4. End every substantive response with a "**Suggested Actions:**" section listing 2-4 specific next steps
5. Format actions as: "→ [Action description] — [brief why]"

Use markdown for formatting. Be direct and professional. Never make up data — only use what the tools return.

When suggesting navigation actions, include the relevant URL path hint in parentheses so the UI can render a button, like: (url:/merchants-dashboard.html?q=MERCHANTNAME)`;

    // ── AGENTIC LOOP ──────────────────────────────────────────────────────────
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        systemInstruction,
        tools: [{ functionDeclarations }]
    });

    const chat = model.startChat({ history: formattedHistory });

    const toolCallsLog = [];
    let result = await chat.sendMessage(query);
    let maxIterations = 6;

    while (maxIterations-- > 0) {
        const calls = result.response.functionCalls();
        if (!calls || calls.length === 0) break;

        const toolResponses = [];
        for (const call of calls) {
            toolCallsLog.push(call.name);
            const toolResult = await executeTool(call.name, call.args || {});
            toolResponses.push({
                functionResponse: { name: call.name, response: toolResult }
            });
        }
        result = await chat.sendMessage(toolResponses);
    }

    const finalAnswer = result.response.text();

    // ── EXTRACT SUGGESTIONS ───────────────────────────────────────────────────
    const suggestions = [];
    const urlMatches = finalAnswer.matchAll(/\(url:([^\)]+)\)/g);
    for (const m of urlMatches) {
        const url = m[1].trim();
        const lineMatch = finalAnswer.slice(0, m.index).split('\n').pop() || '';
        const labelMatch = lineMatch.match(/→\s*([^(]+)/);
        const label = labelMatch ? labelMatch[1].trim().replace(/\*\*/g, '') : 'View';
        suggestions.push({ label, url });
    }

    // Clean the url hints from the final answer text
    const cleanAnswer = finalAnswer.replace(/\s*\(url:[^\)]+\)/g, '');

    // ── PERSIST HISTORY ───────────────────────────────────────────────────────
    await supabase.from('chat_history').insert([
        { userid: userId, role: 'user', content: query },
        { userid: userId, role: 'assistant', content: cleanAnswer }
    ]);

    return res.status(200).json({
        answer: cleanAnswer,
        suggestions,
        tools_used: [...new Set(toolCallsLog)]
    });
}
