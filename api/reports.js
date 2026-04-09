import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, reportType, startDate, endDate, offset = 0, limit = 100 } = req.body;

    if (action === 'getMonthlyReport') {
        try {
            let table, dateField, selectQuery;

            // Define table-specific logic based on your schema
            if (reportType === 'inventory') {
                table = 'equipments';
                dateField = 'received_date'; //
                selectQuery = `serial_number, terminal_type, status, current_location, condition, received_date`;
            } else if (reportType === 'deployments') {
                table = 'deployments';
                dateField = 'target_deployment_date'; //
                selectQuery = `deployment_id, tid, tracking_id, target_deployment_date, status, merchants:merchant_id(dba_name), equipments:equipment_id(serial_number)`;
            } else if (reportType === 'returns') {
                table = 'returns';
                dateField = 'return_date_initiated'; //
                selectQuery = `return_id, return_reason, condition, status, return_date_initiated, equipment_received_date, merchants:merchant_id(dba_name), equipments:equipment_id(serial_number)`;
            }

            // Execute query with 'exact' count to handle large datasets
            const { data, error, count } = await supabase
                .from(table)
                .select(selectQuery, { count: 'exact' })
                .gte(dateField, startDate)
                .lte(dateField, endDate)
                .range(offset, offset + limit - 1)
                .order(dateField, { ascending: false });

            if (error) throw error;

            return res.status(200).json({ success: true, rawData: data, totalCount: count });
        } catch (err) {
            return res.status(500).json({ success: false, message: err.message });
        }
    }
}
