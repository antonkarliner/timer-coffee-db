-- Fix cron jobs and complete automation infrastructure for FCM system
-- This migration removes duplicates, schedules missing jobs, and adds monitoring

-- =====================================================================
-- 1. Remove duplicate cron job (process_scheduled_notifications)
-- =====================================================================
do $$
declare
    v_job_id integer;
begin
    -- Remove any duplicate jobs with underscore naming
    select jobid into v_job_id from cron.job where jobname = 'process_scheduled_notifications';
    
    if v_job_id is not null then
        perform cron.unschedule('process_scheduled_notifications');
        raise notice 'Removed duplicate cron job: process_scheduled_notifications';
    end if;
end;
$$;

-- =====================================================================
-- 2. Update analytics cron function to include X-System-Token header
-- =====================================================================
create or replace function public.aggregate_notification_analytics_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    project_url text := (
        select decrypted_secret from supabase_vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from supabase_vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from supabase_vault.decrypted_secrets where name = 'service_role_key'
    );
    target_window timestamptz := date_trunc('hour', timezone('utc', now())) - interval '1 hour';
    aggregate_date text := to_char(target_window, 'YYYY-MM-DD');
    aggregate_hour integer := extract(hour from target_window);
    edge_function_url text;
    http_response jsonb;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if cron_secret is null then
        raise exception 'Vault secret cron_job_secret is not set.';
    end if;

    if service_key is null then
        raise exception 'Vault secret service_role_key is not set.';
    end if;

    edge_function_url := project_url || '/functions/v1/aggregate-notification-analytics';

    -- Make HTTP request with proper authentication headers
    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('date', aggregate_date, 'hour', aggregate_hour),
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
        'analytics_aggregation_cron',
        1,
        jsonb_build_object(
            'date', aggregate_date,
            'hour', aggregate_hour,
            'status', COALESCE((http_response->>'status'), 'unknown'),
            'response_code', COALESCE((http_response->>'status_code'), 'unknown')::integer,
            'executed_at', timezone('utc', now())
        )
    );

    -- Check for HTTP errors and raise exception if needed
    if http_response->>'status' = 'error' or (http_response->>'status_code')::integer >= 400 then
        raise exception 'Analytics aggregation failed: %', http_response->>'content';
    end if;
end;
$$;

comment on function public.aggregate_notification_analytics_cron() is 'Calls the analytics Edge Function to roll up metrics for the previous UTC hour with proper authentication and monitoring.';

-- =====================================================================
-- 3. Create token cleanup cron function
-- =====================================================================
create or replace function public.token_cleanup_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
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
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if cron_secret is null then
        raise exception 'Vault secret cron_job_secret is not set.';
    end if;

    if service_key is null then
        raise exception 'Vault secret service_role_key is not set.';
    end if;

    edge_function_url := project_url || '/functions/v1/token-maintenance';

    -- Make HTTP request to token maintenance function
    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('action', 'cleanup', 'maxAgeDays', 90),
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
        'token_cleanup_cron',
        COALESCE((http_response->>'deleted')::integer, 0),
        jsonb_build_object(
            'max_age_days', 90,
            'status', COALESCE((http_response->>'status'), 'unknown'),
            'response_code', COALESCE((http_response->>'status_code'), 'unknown')::integer,
            'executed_at', timezone('utc', now())
        )
    );

    -- Check for HTTP errors and raise exception if needed
    if http_response->>'status' = 'error' or (http_response->>'status_code')::integer >= 400 then
        raise exception 'Token cleanup failed: %', http_response->>'content';
    end if;
end;
$$;

comment on function public.token_cleanup_cron() is 'Calls the token-maintenance Edge Function to clean up tokens older than 90 days with proper authentication and monitoring.';

-- =====================================================================
-- 4. Schedule all cron jobs properly
-- =====================================================================
do $cron$
declare
    v_job_id integer;
begin
    -- Schedule analytics aggregation cron job (every hour at 5 minutes past)
    select jobid into v_job_id from cron.job where jobname = 'aggregate-notification-analytics';
    
    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;
    
    select cron.schedule(
        'aggregate-notification-analytics',
        '5 * * * *',
        'select public.aggregate_notification_analytics_cron();'
    ) into v_job_id;
    
    raise notice 'Scheduled analytics aggregation cron job: aggregate-notification-analytics (every hour at 5 minutes past)';

    -- Schedule token cleanup cron job (daily at 2 AM)
    select jobid into v_job_id from cron.job where jobname = 'cleanup-invalid-tokens';
    
    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;
    
    select cron.schedule(
        'cleanup-invalid-tokens',
        '0 2 * * *',
        'select public.token_cleanup_cron();'
    ) into v_job_id;
    
    raise notice 'Scheduled token cleanup cron job: cleanup-invalid-tokens (daily at 2 AM)';

    -- Ensure process-scheduled-notifications job exists and is properly configured
    select jobid into v_job_id from cron.job where jobname = 'process-scheduled-notifications';
    
    if v_job_id is null then
        select cron.schedule(
            'process-scheduled-notifications',
            '* * * * *',
            'select public.process_scheduled_notifications_cron();'
        ) into v_job_id;
        
        raise notice 'Scheduled process-scheduled-notifications cron job (every minute)';
    else
        raise notice 'process-scheduled-notifications cron job already exists';
    end if;
end;
$cron$
language plpgsql;

-- =====================================================================
-- 5. Create cron job monitoring view
-- =====================================================================
create or replace view public.cron_job_status as
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
        when j.jobname = 'process-scheduled-notifications' then 'Every minute'
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
        where cl.action = j.jobname || '_cron' or cl.action = replace(j.jobname, '-', '_') || '_cron'
        order by cl.created_at desc
        limit 1
    ) as last_execution_status
from cron.job j
order by j.jobname;

comment on view public.cron_job_status is 'Monitor status and execution history of all FCM system cron jobs.';

-- =====================================================================
-- 6. Create function to test cron jobs manually
-- =====================================================================
create or replace function public.test_cron_job(p_job_name text)
returns table (
    job_name text,
    execution_time timestamptz,
    status text,
    message text,
    details jsonb
)
language plpgsql
security definer
set search_path = public
as $$
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

comment on function public.test_cron_job(text) is 'Manually test a specific cron job for debugging and verification purposes.';

-- =====================================================================
-- 7. Grant necessary permissions
-- =====================================================================
grant select on public.cron_job_status to authenticated;
grant select on public.cron_job_status to service_role;
grant execute on function public.test_cron_job(text) to service_role;

-- Log the completion of this migration
insert into service.cleanup_logs (action, records_affected, details)
values (
    'cron_automation_fix',
    1,
    jsonb_build_object(
        'migration', '20251111000000_fix_cron_jobs_automation',
        'actions_completed', jsonb_build_array(
            'removed_duplicate_cron_jobs',
            'updated_analytics_function_auth',
            'created_token_cleanup_function',
            'scheduled_missing_cron_jobs',
            'created_monitoring_view',
            'created_test_function'
        ),
        'executed_at', timezone('utc', now())
    )
);