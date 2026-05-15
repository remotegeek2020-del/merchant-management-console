import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';
import { dispatchEvent } from './v1/_deliver.js';

// Partner actions carry their own `token` and use validatePartner() internally.
// All other actions are staff-only and require a valid staff session.
const PARTNER_ACTIONS = new Set([
    'get_merchant_equipment','create','list_for_partner','get_unread_total','get_partner_unread_counts',
    'get_detail','add_comment','get_linked_deployment','mark_delivered',
    'get_comments','get_rma_addable_items','add_items_to_rma','get_terminal_types'
]);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action } = req.body;

    let staffSession = null;
    if (!PARTNER_ACTIONS.has(action)) {
        staffSession = await validateSession(req);
        if (!staffSession) return sessionErrorResponse(res);
    }

    try {
        function logActivity({ email, action: logAction, target_id, severity = 'info', old_value, new_value }) {
            supabase.from('activity_logs').insert({
                email: email || 'System',
                action: logAction,
                status: 'success',
                category: 'ticket',
                target_id: target_id ? String(target_id) : null,
                target_type: 'ticket',
                severity,
                old_value: old_value || null,
                new_value: new_value || null,
                user_agent: req.headers['user-agent'],
                ip_address: req.headers['x-forwarded-for'] || 'Internal'
            }).then(() => {}).catch(e => console.error('[ActivityLog]', e.message));
        }
        async function validatePartner(token) {
            if (!token) return null;
            const { data } = await supabase.from('partner_sessions')
                .select('person_id, expires_at').eq('session_token', token).single();
            if (!data || new Date(data.expires_at) < new Date()) return null;
            return data.person_id;
        }

        async function sendEmail(to, subject, htmlBody, textBody) {
            if (!process.env.POSTMARK_SERVER_TOKEN) return;
            try {
                const { ServerClient } = await import('postmark');
                const client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
                await client.sendEmail({
                    From: process.env.EMAIL_FROM || 'noreply@mypayprotec.com',
                    To: to, Subject: subject, HtmlBody: htmlBody, TextBody: textBody,
                    MessageStream: 'outbound'
                });
            } catch (e) { console.error('[EMAIL] Failed:', e.message); }
        }

        function genId(prefix) {
            const ym = new Date().toISOString().slice(0, 7).replace('-', '');
            return `${prefix}-${ym}-${Math.floor(Math.random() * 99999 + 1).toString().padStart(5, '0')}`;
        }

        function emailLayout(content) {
            return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;">
                <img src="https://assets.cdn.filesafe.space/dfg08aPdtlQ1RhIKkCnN/media/66cf5cf28a35e448970f1ead.png" style="height:36px;margin-bottom:24px;display:block;">
                ${content}
                <hr style="border:0;border-top:1px solid #e2e8f0;margin:24px 0;">
                <p style="font-size:11px;color:#94a3b8;text-align:center;">PayProTec Partner Portal · Support</p>
            </div>`;
        }

        if (action === 'get_merchant_equipment') {
            const { token, merchant_id } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { data: merchant } = await supabase
                .from('merchants').select('id, dba_name').eq('merchant_id', merchant_id).single();
            if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

            // Single units: query equipments directly — deployment record status is unreliable
            const { data: singleEquip } = await supabase
                .from('equipments')
                .select('id, serial_number, terminal_type, deployments!equipment_id(id, deployment_id, created_at)')
                .eq('status', 'deployed')
                .eq('merchant_id', merchant.id);

            const singles = (singleEquip || []).map(e => {
                const deps = Array.isArray(e.deployments) ? e.deployments : (e.deployments ? [e.deployments] : []);
                const latest = deps.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
                return {
                    id: e.id,
                    serial_number: e.serial_number,
                    terminal_type: e.terminal_type,
                    deployment_internal_id: latest?.id || null,
                    deployment_display_id: latest?.deployment_id || null
                };
            });

            // Bulk deployments: check active units via deployment_items
            const { data: bulkDeps } = await supabase
                .from('deployments')
                .select('id, deployment_id, deployment_items(equipment_id, equip:equipment_id(id, serial_number, terminal_type, status))')
                .eq('merchant_id', merchant.id)
                .eq('is_bulk', true)
                .order('created_at', { ascending: false });

            const bulks = (bulkDeps || []).filter(d =>
                d.deployment_items?.some(item => item.equip?.status === 'deployed')
            );

            // Remove from singles any unit already covered by a bulk deployment
            const bulkEquipIds = new Set(bulks.flatMap(d => (d.deployment_items || []).map(i => i.equipment_id)));
            const filteredSingles = singles.filter(s => !bulkEquipIds.has(s.id));

            return res.status(200).json({ success: true, singles: filteredSingles, bulks });
        }

        if (action === 'create') {
            const { token, merchant_id, type, category, subject, description, priority, deployment_id, equipment_serial } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            if (!type || !subject) return res.status(400).json({ success: false, message: 'Type and subject are required.' });

            if (merchant_id) {
                const { data: person } = await supabase.from('persons').select('id').eq('id', personId).single();
                if (!person) return res.status(401).json({ success: false, message: 'Partner not found.' });
            }

            const { data: ticket, error } = await supabase.from('support_tickets').insert({
                person_id: personId,
                merchant_id: merchant_id || null,
                type,
                category: category || null,
                subject,
                description: description || null,
                priority: priority || 'normal',
                equipment_serial: deployment_id || equipment_serial || null
            }).select('id, ticket_number, status, created_at').single();

            if (error) throw error;

            // Log creation in audit trail
            await supabase.from('ticket_comments').insert({
                ticket_id: ticket.id,
                author_type: 'system',
                author_name: 'System',
                change_summary: 'Ticket created',
                is_internal: true
            });

            // Fire webhooks (fire-and-forget)
            const { data: person } = await supabase.from('persons').select('full_name, email').eq('id', personId).single();
            logActivity({ email: person?.email || `partner:${personId}`, action: `Ticket created: "${subject}" [${ticket.ticket_number}]`, target_id: ticket.id });
            dispatchEvent(personId, 'ticket.created', {
                ticket_number: ticket.ticket_number,
                subject,
                type,
                priority: priority || 'normal',
                status: ticket.status,
                partner_name: person?.full_name || 'Partner',
                created_at: ticket.created_at
            }).catch(() => {});

            return res.status(200).json({ success: true, ticket });
        }

        if (action === 'list_for_partner') {
            const { token, merchant_uuid } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            let query = supabase.from('support_tickets')
                .select('id, ticket_number, type, category, subject, status, priority, partner_unread_count, created_at, updated_at, merchant_id, linked_deployment_id, linked_return_id, merchants:merchant_id(dba_name)')
                .eq('person_id', personId)
                .order('created_at', { ascending: false });

            if (merchant_uuid) query = query.eq('merchant_id', merchant_uuid);

            const { data, error } = await query;
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'get_unread_total') {
            const { token } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { data } = await supabase.from('support_tickets')
                .select('partner_unread_count')
                .eq('person_id', personId)
                .not('status', 'in', '(closed,resolved)');
            const total = (data || []).reduce((s, t) => s + (t.partner_unread_count || 0), 0);
            return res.status(200).json({ success: true, total });
        }

        if (action === 'get_partner_unread_counts') {
            const { token } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { data } = await supabase.from('support_tickets')
                .select('id, partner_unread_count')
                .eq('person_id', personId);
            return res.status(200).json({ success: true, counts: data || [] });
        }

        if (action === 'list_for_staff') {
            const { status, type, limit = 200, mine_name, merchant_id, person_id } = req.body;
            let query = supabase.from('support_tickets')
                .select('id, ticket_number, type, category, subject, description, status, priority, assigned_to, created_at, updated_at, merchant_id, person_id, has_unread_partner_comment, unread_count, partner_unread_count, linked_deployment_id, linked_return_id, merchants:merchant_id(dba_name), persons:person_id(full_name, email)')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (status && status !== 'all') query = query.eq('status', status);
            if (type && type !== 'all') query = query.eq('type', type);
            if (mine_name) query = query.eq('assigned_to', mine_name);
            if (merchant_id) query = query.eq('merchant_id', merchant_id);
            if (person_id) query = query.eq('person_id', person_id);

            const { data, error } = await query;
            if (error) throw error;
            return res.status(200).json({ success: true, data: data || [] });
        }

        if (action === 'get_detail') {
            const { ticket_id, token } = req.body;
            const { data: ticket, error } = await supabase.from('support_tickets')
                .select('*, merchants:merchant_id(dba_name, merchant_id, merchant_city, merchant_state, merchant_phone), persons:person_id(full_name, email, phone_number)')
                .eq('id', ticket_id)
                .single();

            if (error || !ticket) return res.status(404).json({ success: false, message: 'Ticket not found.' });

            if (token) {
                const personId = await validatePartner(token);
                if (!personId || ticket.person_id !== personId)
                    return res.status(403).json({ success: false, message: 'Access denied.' });
                // Reset partner badge when partner opens the ticket
                await supabase.from('support_tickets').update({ partner_unread_count: 0 }).eq('id', ticket_id);
            }

            return res.status(200).json({ success: true, ticket });
        }

        if (action === 'update_status') {
            const { ticket_id, status, assigned_to, staff_notes, priority, staff_name } = req.body;
            if (!ticket_id) return res.status(400).json({ success: false, message: 'ticket_id required.' });

            const { data: oldTicket } = await supabase.from('support_tickets')
                .select('status, priority, assigned_to, person_id, ticket_number, subject')
                .eq('id', ticket_id).single();

            const updates = { updated_at: new Date().toISOString() };
            const changes = [];
            if (status && status !== oldTicket?.status) {
                updates.status = status;
                changes.push(`Status changed from <b>${oldTicket?.status}</b> → <b>${status}</b>`);
                if (status === 'resolved') updates.resolved_at = new Date().toISOString();
            }
            if (priority && priority !== oldTicket?.priority) {
                updates.priority = priority;
                changes.push(`Priority changed to <b>${priority}</b>`);
            }
            if (assigned_to !== undefined && assigned_to !== oldTicket?.assigned_to) {
                updates.assigned_to = assigned_to;
                changes.push(assigned_to ? `Assigned to <b>${assigned_to}</b>` : 'Unassigned');
            }
            if (staff_notes !== undefined) updates.staff_notes = staff_notes;

            const { error } = await supabase.from('support_tickets').update(updates).eq('id', ticket_id);
            if (error) throw error;

            // Notify partner of changes (status, priority, assignment)
            if (changes.length > 0 && oldTicket?.person_id) {
                await supabase.rpc('increment_partner_unread', { tid: parseInt(ticket_id) });
            }

            // When ticket is closed, clear ticket_id from linked return so its badge disappears
            if (updates.status === 'closed') {
                const { data: fullTicket } = await supabase.from('support_tickets')
                    .select('linked_return_id').eq('id', ticket_id).single();
                if (fullTicket?.linked_return_id) {
                    await supabase.from('returns').update({ ticket_id: null })
                        .eq('return_id', fullTicket.linked_return_id);
                }
            }

            const author = staff_name || 'Staff';

            if (changes.length > 0) {
                await supabase.from('ticket_comments').insert({
                    ticket_id,
                    author_type: 'system',
                    author_name: author,
                    change_summary: changes.join(' · '),
                    is_internal: true
                });
            }

            // Email partner on status change
            if (updates.status && oldTicket?.person_id) {
                const { data: person } = await supabase.from('persons')
                    .select('full_name, email').eq('id', oldTicket.person_id).single();
                if (person?.email) {
                    await sendEmail(
                        person.email,
                        `Ticket Update: ${oldTicket.ticket_number}`,
                        emailLayout(`
                            <h2 style="color:#001e3c;">Your Ticket Has Been Updated</h2>
                            <p style="color:#475569;">Hi <strong>${person.full_name || 'Partner'}</strong>, your support ticket <strong>${oldTicket.ticket_number}</strong> — ${oldTicket.subject} has been updated.</p>
                            <p style="color:#475569;">New status: <strong style="text-transform:capitalize;">${updates.status.replace('_', ' ')}</strong></p>
                            <p style="color:#475569;">Log in to your Partner Portal to view details and respond.</p>`),
                        `Your ticket ${oldTicket.ticket_number} status was updated to ${updates.status}.`
                    );
                }
            }

            if (changes.length > 0) {
                logActivity({ email: staffSession?.email || staff_name || 'Staff', action: `Ticket ${oldTicket?.ticket_number}: ${changes.join(' · ')}`, target_id: ticket_id, old_value: oldTicket?.status, new_value: updates.status || oldTicket?.status });
            }
            // Fire webhook event for status/priority changes
            if (changes.length > 0 && oldTicket?.person_id) {
                dispatchEvent(oldTicket.person_id, 'ticket.updated', {
                    ticket_id,
                    ticket_number: oldTicket.ticket_number,
                    subject: oldTicket.subject,
                    change: changes.join(' · '),
                    new_status: updates.status || oldTicket.status,
                    new_priority: updates.priority || oldTicket.priority,
                    updated_by: staff_name || 'Staff'
                }).catch(() => {});
            }

            return res.status(200).json({ success: true });
        }

        if (action === 'add_comment') {
            const { ticket_id, body, is_internal = false, token, staff_name } = req.body;
            if (!ticket_id || !body?.trim()) return res.status(400).json({ success: false, message: 'ticket_id and body required.' });

            let authorType, authorName, authorId;

            if (token) {
                // Partner comment
                const personId = await validatePartner(token);
                if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

                const { data: curTicket } = await supabase.from('support_tickets')
                    .select('person_id, assigned_to, ticket_number, subject, unread_count')
                    .eq('id', ticket_id).single();
                if (!curTicket || curTicket.person_id !== personId)
                    return res.status(403).json({ success: false, message: 'Access denied.' });

                const { data: person } = await supabase.from('persons')
                    .select('full_name').eq('id', personId).single();

                authorType = 'partner';
                authorName = person?.full_name || 'Partner';
                authorId = personId.toString();

                await supabase.from('support_tickets').update({
                    has_unread_partner_comment: true,
                    unread_count: (curTicket.unread_count || 0) + 1,
                    updated_at: new Date().toISOString()
                }).eq('id', ticket_id);

                // Email assigned staff
                if (curTicket.assigned_to) {
                    const parts = curTicket.assigned_to.trim().split(' ');
                    let staffQuery = supabase.from('users').select('email').eq('first_name', parts[0]);
                    if (parts.length > 1) staffQuery = staffQuery.eq('last_name', parts.slice(1).join(' '));
                    const { data: staffUser } = await staffQuery.maybeSingle();
                    if (staffUser?.email) {
                        await sendEmail(
                            staffUser.email,
                            `Partner Reply on Ticket ${curTicket.ticket_number}`,
                            emailLayout(`
                                <h2 style="color:#001e3c;">New Partner Reply</h2>
                                <p style="color:#475569;"><strong>${authorName}</strong> replied on ticket <strong>${curTicket.ticket_number}</strong> — ${curTicket.subject}:</p>
                                <div style="background:#f8fafc;border-left:4px solid #0d9488;padding:12px 16px;margin:12px 0;font-size:13px;line-height:1.6;">${body.trim()}</div>
                                <p style="color:#475569;">Log in to the Staff Portal to view and respond.</p>`),
                            `${authorName} replied on ticket ${curTicket.ticket_number}. Please log in to respond.`
                        );
                    }
                }
            } else {
                // Staff comment
                authorType = 'staff';
                authorName = staff_name || 'Staff';

                await supabase.from('support_tickets').update({ updated_at: new Date().toISOString() }).eq('id', ticket_id);

                // Notify partner of new staff activity (non-internal only)
                if (!is_internal) {
                    await supabase.rpc('increment_partner_unread', { tid: parseInt(ticket_id) });
                }

                // Email partner for non-internal staff notes
                if (!is_internal) {
                    const { data: ticket } = await supabase.from('support_tickets')
                        .select('person_id, ticket_number, subject').eq('id', ticket_id).single();
                    if (ticket?.person_id) {
                        const { data: person } = await supabase.from('persons')
                            .select('full_name, email').eq('id', ticket.person_id).single();
                        if (person?.email) {
                            await sendEmail(
                                person.email,
                                `New Note on Your Ticket: ${ticket.ticket_number}`,
                                emailLayout(`
                                    <h2 style="color:#001e3c;">Staff Note on Your Ticket</h2>
                                    <p style="color:#475569;">Hi <strong>${person.full_name || 'Partner'}</strong>, ${authorName} added a note on your ticket <strong>${ticket.ticket_number}</strong> — ${ticket.subject}:</p>
                                    <div style="background:#f8fafc;border-left:4px solid #0d9488;padding:12px 16px;margin:12px 0;font-size:13px;line-height:1.6;">${body.trim()}</div>
                                    <p style="color:#475569;">Log in to your Partner Portal to view and reply.</p>`),
                                `${authorName} added a note on your ticket ${ticket.ticket_number}. Log in to view.`
                            );
                        }
                    }
                }
            }

            const { data: comment, error } = await supabase.from('ticket_comments').insert({
                ticket_id,
                author_type: authorType,
                author_name: authorName,
                author_id: authorId || null,
                body: body.trim(),
                is_internal: token ? false : is_internal
            }).select().single();

            if (error) throw error;

            // Fire comment webhook (fire-and-forget)
            const { data: ticketForEvent } = await supabase.from('support_tickets')
                .select('person_id, ticket_number, subject').eq('id', ticket_id).single();
            const commentLabel = token ? 'Partner comment' : (is_internal ? 'Internal note' : 'Staff comment');
            logActivity({ email: token ? `partner:${authorName}` : (staffSession?.email || authorName || 'Staff'), action: `${commentLabel} added on ticket ${ticketForEvent?.ticket_number || ticket_id} by ${authorName}`, target_id: ticket_id });
            if (ticketForEvent?.person_id) {
                dispatchEvent(ticketForEvent.person_id, 'ticket.comment_added', {
                    ticket_number: ticketForEvent.ticket_number,
                    subject: ticketForEvent.subject,
                    author_name: authorName,
                    author_type: authorType,
                    body: body.trim().slice(0, 500)
                }).catch(() => {});
            }

            return res.status(200).json({ success: true, comment });
        }

        if (action === 'get_comments') {
            const { ticket_id, token } = req.body;
            if (!ticket_id) return res.status(400).json({ success: false, message: 'ticket_id required.' });

            let query = supabase.from('ticket_comments')
                .select('*').eq('ticket_id', ticket_id).order('created_at', { ascending: true });

            if (token) {
                const personId = await validatePartner(token);
                if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });
                query = query.eq('is_internal', false);
            }

            const { data, error } = await query;
            if (error) throw error;
            return res.status(200).json({ success: true, comments: data || [] });
        }

        if (action === 'get_unread_counts') {
            const { data, error } = await supabase.from('support_tickets')
                .select('id, unread_count, partner_unread_count')
                .neq('status', 'closed');
            if (error) throw error;
            return res.status(200).json({ success: true, counts: data || [] });
        }

        if (action === 'mark_read') {
            const { ticket_id } = req.body;
            if (!ticket_id) return res.status(400).json({ success: false, message: 'ticket_id required.' });
            await supabase.from('support_tickets')
                .update({ has_unread_partner_comment: false, unread_count: 0 }).eq('id', ticket_id);
            return res.status(200).json({ success: true });
        }

        if (action === 'get_available_equipment') {
            // Delegates to deployments getLookups for equipment, but also allows direct listing
            const { query: term } = req.body;
            let q = supabase.from('equipments').select('id, serial_number, terminal_type, status').eq('status', 'stocked');
            if (term) q = q.ilike('serial_number', `%${term}%`);
            q = q.order('serial_number').limit(20);
            const { data, error } = await q;
            if (error) throw error;
            return res.status(200).json({ success: true, equipment: data || [] });
        }

        if (action === 'get_merchant_deployments') {
            const { merchant_id } = req.body;
            const { data: merchant } = await supabase.from('merchants').select('id').eq('merchant_id', merchant_id).single();
            if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

            const { data, error } = await supabase.from('deployments')
                .select('id, deployment_id, status, is_bulk, created_at, equipments:equipment_id(serial_number, terminal_type, status), deployment_items(equipment_id, equip:equipment_id(serial_number, terminal_type, status)), returns(id, status)')
                .eq('merchant_id', merchant.id)
                .order('created_at', { ascending: false });
            if (error) throw error;

            // Bulk: eligible if any unit is still deployed
            // Single: eligible if equipment is still deployed (takes priority — a Closed
            //   deployment with equipment still at the merchant is a data inconsistency
            //   but the equipment still needs to come back), OR deployment is not Closed
            //   and has no completed RMA
            const eligible = (data || []).filter(d => {
                if (d.is_bulk) {
                    return d.deployment_items?.some(item => item.equip?.status === 'deployed');
                }
                if (d.equipments?.status === 'deployed') return true;
                if (d.status === 'Closed') return false;
                const rets = Array.isArray(d.returns) ? d.returns : (d.returns ? [d.returns] : []);
                return !rets.some(r => r.status === 'Closed');
            });
            return res.status(200).json({ success: true, deployments: eligible });
        }

        if (action === 'create_linked_record') {
            const { ticket_id, record_type, staff_name } = req.body;
            if (!ticket_id || !record_type) return res.status(400).json({ success: false, message: 'ticket_id and record_type required.' });

            const { data: ticket } = await supabase.from('support_tickets')
                .select('merchant_id, type, subject, equipment_serial').eq('id', ticket_id).single();
            if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found.' });

            const author = staff_name || 'Staff';

            if (record_type === 'deployment') {
                const { is_bulk, bulk_items, equipment_id, tid, tracking_id, target_date, purchase_type, notes } = req.body;

                if (!ticket.merchant_id) return res.status(400).json({ success: false, message: 'Ticket has no merchant linked.' });
                const { data: merchant } = await supabase.from('merchants').select('id, dba_name').eq('merchant_id', ticket.merchant_id).single();
                if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found.' });

                if (is_bulk) {
                    if (!bulk_items?.length) return res.status(400).json({ success: false, message: 'bulk_items required for bulk deployment.' });

                    const { data: dep, error: depErr } = await supabase.from('deployments').insert({
                        merchant_id: merchant.id,
                        equipment_id: null,
                        is_bulk: true,
                        tracking_id: tracking_id || null,
                        target_deployment_date: target_date || null,
                        notes: notes || 'Bulk deployment created from support ticket',
                        purchase_type: purchase_type || 'Free Placement',
                        status: 'Open',
                        ticket_id: parseInt(ticket_id)
                    }).select().single();
                    if (depErr) throw depErr;

                    for (const item of bulk_items) {
                        const { data: equip } = await supabase.from('equipments').select('id, serial_number, status').eq('id', item.equipment_id).single();
                        if (!equip || equip.status !== 'stocked') {
                            await supabase.from('deployments').delete().eq('id', dep.id);
                            return res.status(409).json({ success: false, message: `Conflict: ${equip?.serial_number || item.equipment_id} is not available.` });
                        }
                        await supabase.from('deployment_items').insert({ deployment_id: dep.id, equipment_id: item.equipment_id, tid: item.tid || null });
                        const { data: upd } = await supabase.from('equipments')
                            .update({ status: 'deployed', current_location: merchant.dba_name, merchant_id: merchant.id })
                            .eq('id', item.equipment_id).eq('status', 'stocked').select('id');
                        if (!upd?.length) {
                            await supabase.from('deployments').delete().eq('id', dep.id);
                            return res.status(409).json({ success: false, message: `Conflict: ${equip.serial_number} was just deployed by another user.` });
                        }
                        await supabase.from('equipment_logs').insert({
                            equipment_id: item.equipment_id, merchant_id: merchant.id,
                            action: 'Deployed', from_location: 'Warsaw Office', to_location: merchant.dba_name,
                            notes: `Bulk deployment created from support ticket. Type: ${purchase_type || 'N/A'}`
                        });
                    }

                    const deploymentId = dep.deployment_id || dep.id;
                    await supabase.from('support_tickets').update({ linked_deployment_id: String(deploymentId) }).eq('id', ticket_id);
                    await supabase.from('ticket_comments').insert({
                        ticket_id, author_type: 'system', author_name: author,
                        change_summary: `Bulk deployment created: <strong>${deploymentId}</strong> — ${bulk_items.length} unit(s) being prepared for dispatch.`,
                        is_internal: false
                    });
                    await supabase.rpc('increment_partner_unread', { tid: parseInt(ticket_id) });
                    logActivity({ email: staffSession?.email || author, action: `Bulk deployment ${deploymentId} created from ticket ${ticket_id} (${bulk_items.length} unit(s))`, target_id: ticket_id });
                    return res.status(200).json({ success: true, deployment_id: deploymentId });

                } else {
                    if (!equipment_id) return res.status(400).json({ success: false, message: 'equipment_id required.' });

                    const { data: equip } = await supabase.from('equipments').select('id, serial_number, status').eq('id', equipment_id).single();
                    if (!equip) return res.status(404).json({ success: false, message: 'Equipment not found.' });
                    if (equip.status !== 'stocked') return res.status(400).json({ success: false, message: `Conflict: Serial ${equip.serial_number} is not available (status: ${equip.status}).` });

                    const { data: dep, error: depErr } = await supabase.from('deployments').insert({
                        merchant_id: merchant.id,
                        equipment_id: equip.id,
                        tid: tid || null,
                        tracking_id: tracking_id || null,
                        target_deployment_date: target_date || null,
                        notes: notes || 'Created from support ticket',
                        purchase_type: purchase_type || 'Free Placement',
                        status: 'Open',
                        ticket_id: parseInt(ticket_id)
                    }).select().single();
                    if (depErr) throw depErr;

                    const { data: updateResult } = await supabase.from('equipments')
                        .update({ status: 'deployed', current_location: merchant.dba_name, merchant_id: merchant.id })
                        .eq('id', equip.id).eq('status', 'stocked').select('id');
                    if (!updateResult || !updateResult.length) {
                        await supabase.from('deployments').delete().eq('id', dep.id);
                        return res.status(409).json({ success: false, message: `Conflict: Serial ${equip.serial_number} was just deployed by another user.` });
                    }

                    await supabase.from('equipment_logs').insert({
                        equipment_id: equip.id, merchant_id: merchant.id,
                        action: 'Deployed', from_location: 'Warsaw Office', to_location: merchant.dba_name,
                        notes: `Deployment created from support ticket. Type: ${purchase_type || 'N/A'}`
                    });

                    const deploymentId = dep.deployment_id || dep.id;
                    await supabase.from('support_tickets').update({ linked_deployment_id: String(deploymentId) }).eq('id', ticket_id);
                    await supabase.from('ticket_comments').insert({
                        ticket_id, author_type: 'system', author_name: author,
                        change_summary: `Deployment record created: <strong>${deploymentId}</strong> — your hardware is being prepared for dispatch.`,
                        is_internal: false
                    });
                    await supabase.rpc('increment_partner_unread', { tid: parseInt(ticket_id) });
                    logActivity({ email: staffSession?.email || author, action: `Deployment ${deploymentId} created from ticket ${ticket_id}`, target_id: ticket_id });
                    return res.status(200).json({ success: true, deployment_id: deploymentId });
                }

            } else if (record_type === 'rma') {
                const { deployment_internal_id, return_reason, return_date_initiated, notes, is_bulk, selected_equipment_ids } = req.body;
                if (!deployment_internal_id || !return_reason) return res.status(400).json({ success: false, message: 'deployment_internal_id and return_reason required.' });

                const { data: dep } = await supabase.from('deployments')
                    .select('id, equipment_id, merchant_id, deployment_id, is_bulk').eq('id', deployment_internal_id).single();
                if (!dep) return res.status(404).json({ success: false, message: 'Deployment not found.' });

                const returnId = genId('RMA');
                const dateInitiated = return_date_initiated || new Date().toISOString().split('T')[0];
                const isBulkDep = dep.is_bulk || is_bulk;

                if (isBulkDep) {
                    const { data: ret, error: retErr } = await supabase.from('returns').insert({
                        return_id: returnId,
                        deployment_id: dep.id,
                        equipment_id: null,
                        merchant_id: dep.merchant_id,
                        return_reason,
                        notes: notes || null,
                        return_date_initiated: dateInitiated,
                        condition: 'IN TRANSIT',
                        destination: 'In Transit / RMA',
                        status: 'Open',
                        is_bulk: true,
                        ticket_id: parseInt(ticket_id)
                    }).select('id, return_id').single();
                    if (retErr) throw retErr;

                    // Use selected units, or fall back to all deployment_items
                    let equipIds = selected_equipment_ids?.length ? selected_equipment_ids : null;
                    if (!equipIds) {
                        const { data: depItems } = await supabase.from('deployment_items').select('equipment_id').eq('deployment_id', dep.id);
                        equipIds = (depItems || []).map(di => di.equipment_id);
                    }

                    if (equipIds.length) {
                        await supabase.from('return_items').insert(equipIds.map(eqId => ({ return_id: ret.id, equipment_id: eqId, condition: 'IN TRANSIT' })));
                        await supabase.from('equipment_logs').insert(equipIds.map(eqId => ({
                            equipment_id: eqId, merchant_id: dep.merchant_id, deployment_id: dep.id,
                            action: 'RMA Initiated', from_location: 'Merchant Site', to_location: 'In Transit / RMA',
                            notes: `Bulk RMA initiated from support ticket. Reason: ${return_reason}`
                        })));
                    }

                    const finalReturnId = ret.return_id || returnId;
                    await supabase.from('support_tickets').update({ linked_return_id: finalReturnId }).eq('id', ticket_id);
                    await supabase.from('ticket_comments').insert({
                        ticket_id, author_type: 'system', author_name: author,
                        change_summary: `Bulk Return/RMA initiated: <strong>${finalReturnId}</strong> — ${equipIds.length} unit(s) marked In Transit.`,
                        is_internal: false
                    });
                    await supabase.rpc('increment_partner_unread', { tid: parseInt(ticket_id) });
                    logActivity({ email: staffSession?.email || author, action: `Bulk RMA ${finalReturnId} created from ticket ${ticket_id} (${equipIds.length} unit(s))`, target_id: ticket_id });
                    return res.status(200).json({ success: true, return_id: finalReturnId });

                } else {
                    // Check for existing open RMA for this deployment before inserting
                    const { data: existingRet } = await supabase.from('returns')
                        .select('id, return_id').eq('deployment_id', dep.id).eq('status', 'Open')
                        .limit(1).maybeSingle();

                    let ret;
                    if (existingRet) {
                        ret = existingRet;
                    } else {
                        const { data: newRet, error: retErr } = await supabase.from('returns').insert({
                            return_id: returnId,
                            deployment_id: dep.id,
                            equipment_id: dep.equipment_id,
                            merchant_id: dep.merchant_id,
                            return_reason,
                            notes: notes || null,
                            return_date_initiated: dateInitiated,
                            condition: 'IN TRANSIT',
                            destination: 'In Transit / RMA',
                            status: 'Open',
                            ticket_id: parseInt(ticket_id)
                        }).select('id, return_id').single();
                        if (retErr) throw retErr;
                        ret = newRet;
                    }

                    await supabase.from('equipment_logs').insert({
                        equipment_id: dep.equipment_id, merchant_id: dep.merchant_id, deployment_id: dep.id,
                        action: 'RMA Initiated', from_location: 'Merchant Site', to_location: 'In Transit / RMA',
                        notes: `RMA initiated from support ticket. Reason: ${return_reason}`
                    });

                    const finalReturnId = ret.return_id || returnId;
                    await supabase.from('support_tickets').update({ linked_return_id: finalReturnId }).eq('id', ticket_id);
                    await supabase.from('ticket_comments').insert({
                        ticket_id, author_type: 'system', author_name: author,
                        change_summary: `Return/RMA initiated: <strong>${finalReturnId}</strong> — unit is being returned for inspection.`,
                        is_internal: false
                    });
                    await supabase.rpc('increment_partner_unread', { tid: parseInt(ticket_id) });
                    logActivity({ email: staffSession?.email || author, action: `RMA ${finalReturnId} created from ticket ${ticket_id}`, target_id: ticket_id });
                    return res.status(200).json({ success: true, return_id: finalReturnId });
                }
            }

            return res.status(400).json({ success: false, message: 'Invalid record_type.' });
        }

        if (action === 'get_terminal_types') {
            const { data, error } = await supabase
                .from('equipments')
                .select('terminal_type')
                .not('terminal_type', 'is', null)
                .neq('terminal_type', '');
            if (error) throw error;
            const types = [...new Set((data || []).map(e => e.terminal_type))].filter(Boolean).sort();
            return res.status(200).json({ success: true, types });
        }

        if (action === 'get_linked_deployment') {
            const { token, deployment_id } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { data: dep, error } = await supabase
                .from('deployments')
                .select('id, deployment_id, status, tracking_id, target_deployment_date, merchant_received_date, notes, purchase_type, created_at, ticket_id, is_bulk, equipments:equipment_id(terminal_type, serial_number), merchants:merchant_id(dba_name, merchant_id), deployment_items(id, equipment_id, tid, equip:equipment_id(serial_number, terminal_type))')
                .eq('deployment_id', deployment_id)
                .single();
            if (error || !dep) return res.status(404).json({ success: false, message: 'Deployment record not found. It may have been archived or processed.' });
            return res.status(200).json({ success: true, deployment: dep });
        }

        if (action === 'mark_delivered') {
            const { token, deployment_id, ticket_id } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { data: dep } = await supabase
                .from('deployments')
                .select('id, status, ticket_id, equipment_id, merchant_id, is_bulk, merchants:merchant_id(dba_name)')
                .eq('deployment_id', deployment_id)
                .single();
            if (!dep) return res.status(404).json({ success: false, message: 'Deployment not found.' });

            // Ownership check: the linked ticket must belong to this partner
            const ownerTicketId = ticket_id || dep.ticket_id;
            if (!ownerTicketId) return res.status(403).json({ success: false, message: 'Cannot verify ownership: no linked ticket.' });
            const { data: ownerCheck } = await supabase.from('support_tickets')
                .select('person_id').eq('id', ownerTicketId).single();
            if (!ownerCheck || ownerCheck.person_id !== personId) {
                return res.status(403).json({ success: false, message: 'Access denied: this deployment does not belong to your account.' });
            }

            // Close the deployment and stamp the merchant received date
            const today = new Date().toISOString().split('T')[0];
            await supabase.from('deployments')
                .update({ status: 'Closed', merchant_received_date: today })
                .eq('id', dep.id);

            // Log delivery for each unit (single or bulk)
            if (dep.is_bulk) {
                const { data: depItems } = await supabase
                    .from('deployment_items')
                    .select('equipment_id')
                    .eq('deployment_id', dep.id);
                if (depItems?.length) {
                    await supabase.from('equipment_logs').insert(
                        depItems.map(di => ({
                            equipment_id: di.equipment_id,
                            merchant_id: dep.merchant_id,
                            deployment_id: dep.id,
                            action: 'Delivered',
                            from_location: 'In Transit',
                            to_location: dep.merchants?.dba_name || 'Merchant',
                            notes: 'Marked as delivered by partner via portal (bulk)'
                        }))
                    );
                }
            } else {
                await supabase.from('equipment_logs').insert({
                    equipment_id: dep.equipment_id,
                    merchant_id: dep.merchant_id,
                    deployment_id: dep.id,
                    action: 'Delivered',
                    from_location: 'In Transit',
                    to_location: dep.merchants?.dba_name || 'Merchant',
                    notes: 'Marked as delivered by partner via portal'
                });
            }

            // Close the linked ticket
            const finalTicketId = ticket_id || dep.ticket_id;
            if (finalTicketId) {
                await supabase.from('support_tickets')
                    .update({ status: 'closed', updated_at: new Date().toISOString() })
                    .eq('id', finalTicketId);
                await supabase.from('ticket_comments').insert({
                    ticket_id: finalTicketId,
                    author_type: 'system',
                    author_name: 'Partner',
                    change_summary: 'Equipment confirmed received by merchant. Deployment marked as delivered. Ticket closed.',
                    is_internal: false
                });
            }

            logActivity({ email: `partner:${personId}`, action: `Deployment ${deployment_id} marked as delivered by partner; ticket closed`, target_id: finalTicketId || ticket_id });
            return res.status(200).json({ success: true });
        }

        if (action === 'delete_ticket') {
            const { ticket_id } = req.body;
            if (!ticket_id) return res.status(400).json({ success: false, message: 'ticket_id required.' });

            const { data: deletedTicket } = await supabase.from('support_tickets').select('ticket_number, subject').eq('id', ticket_id).single();
            // Delete comments first (FK), then the ticket
            await supabase.from('ticket_comments').delete().eq('ticket_id', ticket_id);
            const { error } = await supabase.from('support_tickets').delete().eq('id', ticket_id);
            if (error) throw error;
            logActivity({ email: staffSession?.email || 'Staff', action: `Ticket deleted: "${deletedTicket?.subject || ''}" [${deletedTicket?.ticket_number || ticket_id}]`, target_id: ticket_id, severity: 'warning' });
            return res.status(200).json({ success: true });
        }

        // Partner-authenticated RMA add-items actions
        if (action === 'get_rma_addable_items') {
            const { token, return_display_id } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { data: rma } = await supabase.from('returns')
                .select('id, status, deployment_id').eq('return_id', return_display_id).single();
            if (!rma) return res.status(404).json({ success: false, message: 'RMA not found.' });
            if (rma.status !== 'Open') return res.status(400).json({ success: false, message: 'RMA is already closed.' });

            const { data: depItems } = await supabase.from('deployment_items')
                .select('equipment_id, equip:equipment_id(id, serial_number, terminal_type, status)')
                .eq('deployment_id', rma.deployment_id);

            const { data: existing } = await supabase.from('return_items')
                .select('equipment_id').eq('return_id', rma.id);
            const existingIds = new Set((existing || []).map(e => e.equipment_id));

            const addable = (depItems || []).filter(di =>
                di.equip?.status === 'deployed' && !existingIds.has(di.equipment_id)
            );

            return res.status(200).json({ success: true, items: addable, rma_uuid: rma.id });
        }

        if (action === 'add_items_to_rma') {
            const { token, return_uuid, equipment_ids } = req.body;
            const personId = await validatePartner(token);
            if (!personId) return res.status(401).json({ success: false, message: 'Session expired.' });

            const { data: rma } = await supabase.from('returns')
                .select('id, return_id, status, merchant_id').eq('id', return_uuid).single();
            if (!rma) return res.status(404).json({ success: false, message: 'RMA not found.' });
            if (rma.status !== 'Open') return res.status(400).json({ success: false, message: 'RMA is already closed.' });

            await supabase.from('return_items').insert(
                equipment_ids.map(eqId => ({ return_id: rma.id, equipment_id: eqId, condition: 'IN TRANSIT' }))
            );
            await supabase.from('equipment_logs').insert(
                equipment_ids.map(eqId => ({
                    equipment_id: eqId, merchant_id: rma.merchant_id,
                    action: 'Added to RMA', from_location: 'Merchant Site', to_location: 'In Transit / RMA',
                    notes: `Partner added to existing RMA ${rma.return_id}`
                }))
            );

            return res.status(200).json({ success: true, added: equipment_ids.length });
        }

        return res.status(400).json({ success: false, message: 'Unknown action.' });

    } catch (err) {
        console.error('Tickets Error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
