import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, reportType, startDate, endDate, subFilter, offset = 0, limit = 100 } = req.body;

    if (action === 'getMonthlyReport') {
        try {
            let queryBuilder;
            let dateField;
            let selectQuery;

            // 1. Restore Inventory, Deployments, Returns
            if (reportType === 'inventory') {
                dateField = 'received_date';
                selectQuery = `serial_number, terminal_type, status, current_location, condition, received_date`;
                queryBuilder = supabase.from('equipments').select(selectQuery, { count: 'exact' })
                    .eq('current_location', subFilter); 
            } else if (reportType === 'deployments') {
                dateField = 'target_deployment_date';
                selectQuery = `deployment_id, tid, tracking_id, target_deployment_date, status, merchants:merchant_id(dba_name), equipments:equipment_id(serial_number)`;
                queryBuilder = supabase.from('deployments').select(selectQuery, { count: 'exact' });
            } else if (reportType === 'returns') {
                dateField = 'return_date_initiated';
                selectQuery = `return_id, return_reason, condition, status, return_date_initiated, equipment_received_date, merchants:merchant_id(dba_name), equipments:equipment_id(serial_number)`;
                queryBuilder = supabase.from('returns').select(selectQuery, { count: 'exact' });
            } 
            // 2. FIXED: Prime49 Logic
            else if (reportType === 'prime49') {
                dateField = 'enrollment_date';
                selectQuery = `merchant_id, dba_name, agent_id, company_display_name, partner_full_name, enrollment_date, account_status`;
                queryBuilder = supabase.from('merchant_portfolio_view')
                    .select(selectQuery, { count: 'exact' })
                    .eq('is_prime49', true);
            }

            if (!queryBuilder) return res.status(400).json({ success: false, message: "Invalid report type" });

            // 3. Execute Query with proper Date Suffixes
            const { data, error, count } = await queryBuilder
                .gte(dateField, `${startDate}T00:00:00.000Z`)
                .lte(dateField, `${endDate}T23:59:59.999Z`)
                .range(offset, offset + limit - 1)
                .order(dateField, { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, rawData: data, totalCount: count });
            
        } catch (err) {
            return res.status(500).json({ success: false, message: "Database Error: " + err.message });
        }
    }
    return res.status(400).json({ success: false, message: "Invalid Action" });
}
