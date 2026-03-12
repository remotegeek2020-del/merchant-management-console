CREATE OR REPLACE FUNCTION get_merchant_stats(
    p_status_filter TEXT DEFAULT NULL,
    p_query TEXT DEFAULT NULL,
    p_filter_by TEXT DEFAULT NULL
)
RETURNS TABLE (
    total_mtd NUMERIC,
    total_30d NUMERIC,
    total_90d NUMERIC,
    absolute_total_mtd NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    WITH filtered_stats AS (
        SELECT 
            SUM(COALESCE(volume_mtd, 0)) as f_mtd,
            SUM(COALESCE(volume_30_day, 0)) as f_30,
            SUM(COALESCE(volume_90_day, 0)) as f_90
        FROM merchants
        WHERE (p_status_filter IS NULL OR p_status_filter = '' OR account_status = p_status_filter)
          AND (
            p_query IS NULL OR p_query = '' OR
            CASE 
                WHEN p_filter_by = 'dba_name' THEN dba_name ILIKE '%' || p_query || '%'
                WHEN p_filter_by = 'merchant_id' THEN merchant_id = p_query
                WHEN p_filter_by = 'agent_id' THEN agent_id = p_query
                ELSE TRUE
            END
          )
    ),
    global_stats AS (
        SELECT SUM(COALESCE(volume_mtd, 0)) as abs_mtd FROM merchants
    )
    SELECT 
        fs.f_mtd, fs.f_30, fs.f_90, gs.abs_mtd
    FROM filtered_stats fs, global_stats gs;
END;
$$ LANGUAGE plpgsql;
