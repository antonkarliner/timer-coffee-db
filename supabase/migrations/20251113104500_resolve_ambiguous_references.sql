-- Resolve ambiguous column references in function
-- Migration: 20251113104500_resolve_ambiguous_references
-- Date: 2025-11-13
-- Purpose: Fix ambiguous column references by using proper table aliases

-- Drop and recreate the function with proper table aliases
DROP FUNCTION IF EXISTS service.get_cron_job_status(text,integer,integer) CASCADE;

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
    
    -- Return filtered results using table alias to resolve ambiguity
    RETURN QUERY
    SELECT 
        view.job_id,
        view.job_name,
        view.schedule,
        view.command,
        view.active,
        view.last_run_details
    FROM service.cron_job_status view
    WHERE (p_job_id IS NULL OR view.job_id::TEXT = p_job_id)
    ORDER BY view.job_name
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
    'cron_job_status_ambiguous_reference_fix',
    1,
    jsonb_build_object(
        'migration', '20251113104500_resolve_ambiguous_references',
        'actions_completed', jsonb_build_array(
            'resolved_ambiguous_column_references',
            'added_table_alias_for_disambiguation'
        ),
        'fix_details', jsonb_build_object(
            'issue', 'ambiguous_column_reference_between_parameter_and_table_column',
            'solution', 'used_table_alias_view_to_disambiguate_column_references'
        ),
        'executed_at', timezone('utc', now())
    )
);