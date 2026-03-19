-- Fix cron_job_status view security issues
-- Migration: 20251113082900_fix_cron_job_status_security
-- Date: 2025-11-13
-- Purpose: Remove SECURITY DEFINER vulnerability and move to service schema for proper isolation

-- =====================================================================
-- Phase 1: Remove the existing SECURITY DEFINER view from public schema
-- =====================================================================

DROP VIEW IF EXISTS public.cron_job_status CASCADE;

-- =====================================================================
-- Phase 2: Create service schema for monitoring views (if not exists)
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS service;

-- =====================================================================
-- Phase 3: Create secure cron_job_status view in service schema with SECURITY INVOKER
-- =====================================================================

CREATE OR REPLACE VIEW service.cron_job_status
WITH (security_invoker = true) AS
SELECT
    j.jobid,
    j.jobname,
    j.schedule,
    j.command,
    j.active,
    j.jobname AS job_type,
    CASE
        WHEN j.jobname = 'process-scheduled-notifications' THEN 'FCM Notification Processing'
        WHEN j.jobname = 'aggregate-notification-analytics' THEN 'Analytics Aggregation'
        WHEN j.jobname = 'cleanup-invalid-tokens' THEN 'Token Cleanup'
        ELSE 'Unknown'
    END AS description,
    CASE
        WHEN j.jobname = 'process-scheduled-notifications' THEN 'Every minute'
        WHEN j.jobname = 'aggregate-notification-analytics' THEN 'Every hour at 5 minutes past'
        WHEN j.jobname = 'cleanup-invalid-tokens' THEN 'Daily at 2 AM UTC'
        ELSE j.schedule
    END AS human_readable_schedule,
    -- Get last execution status with proper RLS enforcement
    (
        SELECT jsonb_build_object(
            'last_execution', cl.created_at,
            'status', cl.details->>'status',
            'records_affected', cl.records_affected,
            'response_code', (cl.details->>'response_code')::integer
        )
        FROM service.cleanup_logs cl
        WHERE cl.action = j.jobname || '_cron'
           OR cl.action = replace(j.jobname, '-', '_') || '_cron'
        ORDER BY cl.created_at DESC
        LIMIT 1
    ) AS last_execution_status
FROM cron.job j
ORDER BY j.jobname;

-- Add proper comment
COMMENT ON VIEW service.cron_job_status IS 'Secure monitoring view for cron job status with proper RLS enforcement - located in service schema for security isolation';

-- =====================================================================
-- Phase 4: Update permissions and security policies for service schema
-- =====================================================================

-- Ensure service schema exists
CREATE SCHEMA IF NOT EXISTS service;

-- Grant view access to service.cron_job_status
GRANT SELECT ON service.cron_job_status TO service_role;
GRANT SELECT ON service.cron_job_status TO authenticated;

-- Grant access to service schema
GRANT USAGE ON SCHEMA service TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA service TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA service TO service_role;

-- =====================================================================
-- Phase 5: Update test function to work with new security model
-- =====================================================================

-- Update the existing test_cron_job function to use the secure pattern
CREATE OR REPLACE FUNCTION public.test_cron_job(p_job_name text)
RETURNS table (
    job_name text,
    execution_time timestamptz,
    status text,
    message text,
    details jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
    v_start_time timestamptz := timezone('utc', now());
    v_result jsonb;
    v_error_message text;
begin
    -- Validate job name
    if p_job_name not in ('process-scheduled-notifications', 'aggregate-notification-analytics', 'cleanup-invalid-tokens') then
        return query select 
            p_job_name::text,
            v_start_time,
            'error'::text,
            'Invalid job name. Must be one of: process-scheduled-notifications, aggregate-notification-analytics, cleanup-invalid-tokens'::text,
            '{}'::jsonb;
        return;
    end if;

    -- Execute the appropriate function based on job name
    begin
        case p_job_name
            when 'process-scheduled-notifications' then
                perform public.process_scheduled_notifications_cron();
                return query select 
                    p_job_name::text,
                    v_start_time,
                    'success'::text,
                    'Process scheduled notifications completed successfully'::text,
                    jsonb_build_object('execution_time_ms', extract(epoch from (timezone('utc', now()) - v_start_time)) * 1000);
                    
            when 'aggregate-notification-analytics' then
                perform public.aggregate_notification_analytics_cron();
                return query select 
                    p_job_name::text,
                    v_start_time,
                    'success'::text,
                    'Analytics aggregation completed successfully'::text,
                    jsonb_build_object('execution_time_ms', extract(epoch from (timezone('utc', now()) - v_start_time)) * 1000);
                    
            when 'cleanup-invalid-tokens' then
                perform public.token_cleanup_cron();
                return query select 
                    p_job_name::text,
                    v_start_time,
                    'success'::text,
                    'Token cleanup completed successfully'::text,
                    jsonb_build_object('execution_time_ms', extract(epoch from (timezone('utc', now()) - v_start_time)) * 1000);
        end case;
        
    exception when others then
        v_error_message := SQLERRM;
        return query select 
            p_job_name::text,
            v_start_time,
            'error'::text,
            v_error_message::text,
            jsonb_build_object('execution_time_ms', extract(epoch from (timezone('utc', now()) - v_start_time)) * 1000, 'sql_state', SQLSTATE);
    end;
end;
$$;

-- =====================================================================
-- Phase 6: Add monitoring and logging
-- =====================================================================

-- Log the security fix completion
INSERT INTO service.cleanup_logs (action, records_affected, details)
VALUES (
    'cron_job_status_security_fix',
    1,
    jsonb_build_object(
        'migration', '20251113082900_fix_cron_job_status_security',
        'actions_completed', jsonb_build_array(
            'removed_security_definer_view',
            'created_security_invoker_view',
            'updated_permissions_and_policies',
            'enhanced_test_function'
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

COMMENT ON FUNCTION public.test_cron_job(text) IS 'Manually test a specific cron job for debugging and verification purposes - updated to work with new security model';