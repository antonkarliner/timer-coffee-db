-- Fix cron_job_status function column ambiguity
-- Migration: 20251113102500_fix_cron_job_status_function
-- Date: 2025-11-13
-- Purpose: Fix column ambiguity in get_cron_job_status function

-- Drop and recreate the function with correct column names
DROP FUNCTION IF EXISTS service.get_cron_job_status(text,integer,integer) CASCADE;

CREATE OR REPLACE FUNCTION service.get_cron_job_status(
    p_job_id TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    cron_job_id BIGINT,
    job_name TEXT,
    schedule TEXT,
    command TEXT,
    active BOOLEAN,
    last_run_details JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER -- Use this for the function to control access
SET search_path = service, cron, pg_catalog
AS $$
DECLARE
    v_current_user TEXT;
BEGIN
    -- Get the current user for role-based access control
    v_current_user := current_user;
    
    -- Only allow service_role and authenticated users to access this function
    IF v_current_user NOT IN ('service_role', 'authenticated', 'postgres') AND 
       v_current_user NOT LIKE 'anon%' THEN
        RAISE EXCEPTION 'Unauthorized access to cron job status';
    END IF;
    
    -- Return the filtered results
    RETURN QUERY
    SELECT 
        cs.cron_job_id,
        cs.job_name,
        cs.schedule,
        cs.command,
        cs.active,
        cs.last_run_details
    FROM service.cron_job_status cs
    WHERE (p_job_id IS NULL OR cs.cron_job_id::TEXT = p_job_id)
    ORDER BY cs.job_name
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- Grant execute on the function to authenticated users
GRANT EXECUTE ON FUNCTION service.get_cron_job_status TO authenticated;
GRANT EXECUTE ON FUNCTION service.get_cron_job_status TO service_role;

-- Log the fix completion
INSERT INTO service.cleanup_logs (action, records_affected, details)
VALUES (
    'cron_job_status_function_fix',
    1,
    jsonb_build_object(
        'migration', '20251113102500_fix_cron_job_status_function',
        'actions_completed', jsonb_build_array(
            'fixed_column_ambiguity',
            'updated_function_parameters'
        ),
        'fix_details', jsonb_build_object(
            'issue', 'column_name_conflict_between_function_and_view',
            'solution', 'renamed_columns_in_function_to_match_view'
        ),
        'executed_at', timezone('utc', now())
    )
);