create extension if not exists supabase_vault;
create extension if not exists pg_cron;

-- Helper function to call the FCM scheduled notifications Edge Function
create or replace function public.process_scheduled_notifications_cron()
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

    edge_function_url := project_url || '/functions/v1/process-scheduled-notifications-fcm';

    perform net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('timestamp', now()),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key,
            'X-System-Token', cron_secret
        ),
        timeout_milliseconds := 300000
    );
end;
$$;

comment on function public.process_scheduled_notifications_cron() is 'Invokes the process-scheduled-notifications-fcm Edge Function via pg_net.';

-- Helper function to aggregate notification analytics for the previous UTC hour
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
    service_key text := (
        select decrypted_secret from supabase_vault.decrypted_secrets where name = 'service_role_key'
    );
    target_window timestamptz := date_trunc('hour', timezone('utc', now())) - interval '1 hour';
    aggregate_date text := to_char(target_window, 'YYYY-MM-DD');
    aggregate_hour integer := extract(hour from target_window);
    edge_function_url text;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if service_key is null then
        raise exception 'Vault secret service_role_key is not set.';
    end if;

    edge_function_url := project_url || '/functions/v1/aggregate-notification-analytics';

    perform net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('date', aggregate_date, 'hour', aggregate_hour),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
        ),
        timeout_milliseconds := 300000
    );
end;
$$;

comment on function public.aggregate_notification_analytics_cron() is 'Calls the analytics Edge Function to roll up metrics for the previous UTC hour.';

-- Ensure pg_cron jobs point to the refreshed functions, even on older pg_cron versions
do $cron$
declare
    v_job_id integer;
begin
    -- Reset existing scheduled notifications jobs (old names included)
    select jobid
    into v_job_id
    from cron.job
    where jobname in ('process-scheduled-notifications', 'agg-process-scheduled')
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    select cron.schedule(
        'process-scheduled-notifications',
        '* * * * *',
        'select public.process_scheduled_notifications_cron();'
    )
    into v_job_id;

    -- Reset analytics aggregation jobs (covering legacy names)
    select jobid
    into v_job_id
    from cron.job
    where jobname in ('aggregate-notification-analytics', 'agg-notification-analytics')
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    select cron.schedule(
        'aggregate-notification-analytics',
        '5 * * * *',
        'select public.aggregate_notification_analytics_cron();'
    )
    into v_job_id;
end;
$cron$
language plpgsql;
