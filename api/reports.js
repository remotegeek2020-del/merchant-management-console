import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, reportType, startDate, endDate, subFilter, offset = 0, limit = 100 } = req.body;

    if (action === 'getMonthlyReport') {
        try {
            let table, dateField, selectQuery;
            let queryBuilder;

            if (reportType === 'inventory') {
                table = 'equipments';
                dateField = 'received_date';
                selectQuery = `serial_number, terminal_type, status, current_location, condition, received_date`;
                
                // Separate generation based on location
                queryBuilder = supabase.from(table).select(selectQuery, { count: 'exact' })
                    .eq('current_location', subFilter); // subFilter will be 'Warsaw Office' or 'Warsaw Repairs'
            } else if (reportType === 'deployments') {
                table = 'deployments';
                dateField = 'target_deployment_date';
                selectQuery = `deployment_id, tid, tracking_id, target_deployment_date, status, merchants:merchant_id(dba_name), equipments:equipment_id(serial_number)`;
                queryBuilder = supabase.from(table).select(selectQuery, { count: 'exact' });
            } else if (reportType === 'returns') {
                table = 'returns';
                dateField = 'return_date_initiated';
                selectQuery = `return_id, return_reason, condition, status, return_date_initiated, equipment_received_date, merchants:merchant_id(dba_name), equipments:equipment_id(serial_number)`;
                queryBuilder = supabase.from(table).select(selectQuery, { count: 'exact' });
            }

            const { data, error, count } = await queryBuilder
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
