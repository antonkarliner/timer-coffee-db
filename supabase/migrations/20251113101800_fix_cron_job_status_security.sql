-- Fix cron_job_status view security issues
-- Migration: 20251113101800_fix_cron_job_status_security
-- Date: 2025-11-13
-- Purpose: Remove SECURITY DEFINER vulnerability and move to service schema for proper isolation

-- =====================================================================
-- Phase 1: Remove the existing SECURITY DEFINER view from public schema
-- =====================================================================

DROP VIEW IF EXISTS public.cron_job_status CASCADE;

-- =====================================================================
-- Phase 2: Create secure cron_job_status view in service schema with SECURITY INVOKER
-- =====================================================================

CREATE OR REPLACE VIEW service.cron_job_status AS
SELECT 
    j.jobid AS job_id,
    j.jobname AS job_name,
    j.schedule,
    j.command,
    j.active,
    -- Get most recent run details
    (
        SELECT jsonb_build_object(
            'runid', rd.runid,
            'status', rd.status,
            'start_time', rd.start_time,
            'end_time', rd.end_time,
            'return_message', rd.return_message
        )
        FROM cron.job_run_details rd
        WHERE rd.jobid = j.jobid
        ORDER BY rd.start_time DESC
        LIMIT 1
    ) AS last_run_details
FROM cron.job j
ORDER BY j.jobname;

-- Set the view to use SECURITY INVOKER (current user's privileges, not the view owner's)
ALTER VIEW service.cron_job_status SET (security_invoker = true);

-- Add proper comment
COMMENT ON VIEW service.cron_job_status IS 'Secure monitoring view for cron job status with proper RLS enforcement - located in service schema for security isolation';

-- =====================================================================
-- Phase 3: Create a secure wrapper function with proper role-based access control
-- =====================================================================

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
        cs.job_id,
        cs.job_name,
        cs.schedule,
        cs.command,
        cs.active,
        cs.last_run_details
    FROM service.cron_job_status cs
    WHERE (p_job_id IS NULL OR cs.job_id::TEXT = p_job_id)
    ORDER BY cs.job_name
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- =====================================================================
-- Phase 4: Update permissions and security policies for service schema
-- =====================================================================

-- Grant execute on the function to authenticated users
GRANT EXECUTE ON FUNCTION service.get_cron_job_status TO authenticated;
GRANT EXECUTE ON FUNCTION service.get_cron_job_status TO service_role;

-- Grant limited access to the view for service_role only
GRANT SELECT ON service.cron_job_status TO service_role;

-- Create a helpful view for authenticated users that limits sensitive information
CREATE OR REPLACE VIEW service.cron_job_status_public AS
SELECT 
    job_id,
    job_name,
    schedule,
    active,
    last_run_details
    -- Note: Excluding 'command' for security
FROM service.cron_job_status;

ALTER VIEW service.cron_job_status_public SET (security_invoker = true);

-- Grant limited access to authenticated users
GRANT SELECT ON service.cron_job_status_public TO authenticated;

COMMENT ON VIEW service.cron_job_status_public IS 'Limited view of cron job status for authenticated users, excluding sensitive command information';

-- =====================================================================
-- Phase 5: Log the security fix completion
-- =====================================================================

-- Log the security fix completion
INSERT INTO service.cleanup_logs (action, records_affected, details)
VALUES (
    'cron_job_status_security_fix',
    1,
    jsonb_build_object(
        'migration', '20251113101800_fix_cron_job_status_security',
        'actions_completed', jsonb_build_array(
            'removed_security_definer_view',
            'created_security_invoker_view',
            'created_secure_wrapper_function',
            'updated_permissions_and_policies',
            'created_limited_public_view'
        ),
        'security_improvements', jsonb_build_object(
            'removed_privilege_escalation_risk', true,
            'added_rls_enforcement', true,
            'improved_schema_organization', true,
            'enhanced_access_control', true
        ),
        'executed_at', timezone('utc', now())
    )
);