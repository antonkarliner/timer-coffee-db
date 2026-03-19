-- Revert cron_job_status view security fix
-- Migration: 20251113101000_revert_cron_job_status_security_fix
-- Date: 2025-11-13
-- Purpose: Revert the previous security fix to allow for a corrected implementation

-- =====================================================================
-- Phase 1: Remove the secure view from service schema
-- =====================================================================

DROP VIEW IF EXISTS service.cron_job_status CASCADE;

-- =====================================================================
-- Phase 2: Revert the test function changes
-- =====================================================================

-- Drop the updated test function
DROP FUNCTION IF EXISTS public.test_cron_job(text) CASCADE;

-- =====================================================================
-- Phase 3: Recreate the original cron_job_status view in public schema
-- =====================================================================

-- Recreate the original view with SECURITY DEFINER (as it was originally)
CREATE OR REPLACE VIEW public.cron_job_status
AS
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

-- Set SECURITY DEFINER after view creation
ALTER VIEW public.cron_job_status SET (security_invoker = false);

-- Grant permissions to the original view
GRANT SELECT ON public.cron_job_status TO authenticated;
GRANT SELECT ON public.cron_job_status TO service_role;

-- Add comment explaining this is the original view
COMMENT ON VIEW public.cron_job_status IS 'Original cron job status view - SECURITY DEFINER (being reverted for correction)';

-- =====================================================================
-- Phase 4: Log the revert operation
-- =====================================================================

-- Log the revert operation
INSERT INTO service.cleanup_logs (action, records_affected, details)
VALUES (
    'cron_job_status_security_fix_revert',
    1,
    jsonb_build_object(
        'migration', '20251113101000_revert_cron_job_status_security_fix',
        'actions_completed', jsonb_build_array(
            'removed_secure_service_view',
            'reverted_test_function_changes',
            'recreated_original_public_view',
            'restored_original_permissions'
        ),
        'reason', 'Preparing to apply corrected security fix',
        'executed_at', timezone('utc', now())
    )
);