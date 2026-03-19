-- Final function fix - Drop and recreate function with correct return type
-- Migration: 20251113104000_final_function_fix
-- Date: 2025-11-13
-- Purpose: Drop existing function and recreate with consistent column names

-- Drop the existing function completely
DROP FUNCTION IF EXISTS service.get_cron_job_status(text,integer,integer) CASCADE;

-- Create the function with correct return type that matches the view
CREATE OR REPLACE FUNCTION service.get_cron_job_status(
    p_job_id TEXT DEFAULT NULL,
    p_limit INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    job_id BIGINT,
    job_name TEXT,
    schedule TEXT,
    command TEXT,
    active BOOLEAN,
    last_run_details JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
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
    
    -- Return filtered results using consistent column names with the view
    RETURN QUERY
    SELECT 
        job_id,
        job_name,
        schedule,
        command,
        active,
        last_run_details
    FROM service.cron_job_status
    WHERE (p_job_id IS NULL OR job_id::TEXT = p_job_id)
    ORDER BY job_name
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION service.get_cron_job_status TO authenticated;
GRANT EXECUTE ON FUNCTION service.get_cron_job_status TO service_role;

-- Log the fix
INSERT INTO service.cleanup_logs (action, records_affected, details)
VALUES (
    'cron_job_status_function_final_fix',
    1,
    jsonb_build_object(
        'migration', '20251113104000_final_function_fix',
        'actions_completed', jsonb_build_array(
            'dropped_existing_function',
            'recreated_function_with_correct_return_type'
        ),
        'fix_details', jsonb_build_object(
            'issue', 'cannot_change_return_type_of_existing_function',
            'solution', 'dropped_function_and_recreated_with_correct_signature'
        ),
        'executed_at', timezone('utc', now())
    )
);