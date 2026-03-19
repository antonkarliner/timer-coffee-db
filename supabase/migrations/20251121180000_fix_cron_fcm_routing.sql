-- Fix cron job routing to use FCM notification system instead of OneSignal
-- This migration updates the process_scheduled_notifications_cron function to call the FCM Edge Function
-- ensuring the notification system uses the modern FCM infrastructure

-- Update process_scheduled_notifications_cron function to call FCM Edge Function
CREATE OR REPLACE FUNCTION public.process_scheduled_notifications_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    project_url text := (
        select decrypted_secret from supabase_vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from supabase_vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from supabase_vault.decrypted_secrets where name = 'service_role_key'
    );
    edge_function_url text;
    http_response jsonb;
BEGIN
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if cron_secret is null then
        raise exception 'Vault secret cron_job_secret is not set.';
    end if;

    if service_key is null then
        raise exception 'Vault secret service_role_key is not set.';
    end if;

    -- IMPORTANT: Changed to use FCM Edge Function instead of OneSignal version
    edge_function_url := project_url || '/functions/v1/process-scheduled-notifications-fcm';

    -- Make HTTP request to FCM Edge Function with proper authentication headers
    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('timestamp', now()),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key,
            'X-System-Token', cron_secret
        ),
        timeout_milliseconds := 300000
    ) into http_response;

    -- Log execution result for monitoring
    insert into service.cleanup_logs (action, records_affected, details)
    values (
        'scheduled_notifications_fcm_cron',
        COALESCE((http_response->>'processed')::integer, 0),
        jsonb_build_object(
            'edge_function', 'process-scheduled-notifications-fcm',
            'status', COALESCE((http_response->>'status'), 'unknown'),
            'response_code', COALESCE((http_response->>'status_code')::integer, 500),
            'executed_at', timezone('utc', now())
        )
    );

    -- Check for HTTP errors and raise exception if needed
    if http_response->>'status' = 'error' or (http_response->>'status_code')::integer >= 400 then
        raise exception 'FCM notification processing failed: %', http_response->>'content';
    end if;
END;
$$;

comment on function public.process_scheduled_notifications_cron() is 'Invokes the process-scheduled-notifications-fcm Edge Function via pg_net for FCM notification processing.';

-- Update the monitoring view to reflect FCM usage
DROP VIEW IF EXISTS public.cron_job_status;

CREATE OR REPLACE VIEW public.cron_job_status AS
select 
    j.jobid,
    j.jobname,
    j.schedule,
    j.command,
    j.active,
    j.jobname as job_type,
    case 
        when j.jobname = 'process-scheduled-notifications' then 'FCM Notification Processing'
        when j.jobname = 'aggregate-notification-analytics' then 'Analytics Aggregation'
        when j.jobname = 'cleanup-invalid-tokens' then 'Token Cleanup'
        else 'Unknown'
    end as description,
    case 
        when j.jobname = 'process-scheduled-notifications' then 'Every minute (FCM)'
        when j.jobname = 'aggregate-notification-analytics' then 'Every hour at 5 minutes past'
        when j.jobname = 'cleanup-invalid-tokens' then 'Daily at 2 AM UTC'
        else j.schedule
    end as human_readable_schedule,
    -- Get last execution status from cleanup_logs
    (
        select jsonb_build_object(
            'last_execution', cl.created_at,
            'status', cl.details->>'status',
            'records_affected', cl.records_affected,
            'response_code', (cl.details->>'response_code')::integer
        )
        from service.cleanup_logs cl
        where cl.action = j.jobname || '_cron' or cl.action = 'scheduled_notifications_fcm_cron'
        order by cl.created_at desc
        limit 1
    ) as last_execution_status
from cron.job j
order by j.jobname;

comment on view public.cron_job_status is 'Monitor status and execution history of all FCM system cron jobs. Updated to reflect FCM usage.';

-- Grant necessary permissions
grant select on public.cron_job_status to authenticated;
grant select on public.cron_job_status to service_role;

-- Log completion of this migration
insert into service.cleanup_logs (action, records_affected, details)
values (
    'cron_fcm_routing_fix',
    1,
    jsonb_build_object(
        'migration', '20251121180000_fix_cron_fcm_routing',
        'actions_completed', jsonb_build_array(
            'updated_cron_function_to_fcm',
            'updated_monitoring_view',
            'logged_migration_completion'
        ),
        'previous_url', 'https://your-project-ref.supabase.co/functions/v1/process-scheduled-notifications',
        'new_url', 'https://your-project-ref.supabase.co/functions/v1/process-scheduled-notifications-fcm',
        'executed_at', timezone('utc', now())
    )
);
