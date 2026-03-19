set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.yearly_user_liters_percentile(p_year integer, p_user_id uuid, p_liters double precision DEFAULT NULL::double precision)
 RETURNS TABLE(percentile numeric, top_pct integer, liters double precision, active_users integer)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with base as (
    select liters
    from public.yearly_user_liters
    where year = p_year and brews >= 1
  ),
  me_val as (
    select coalesce(p_liters, (select liters from public.yearly_user_liters where year = p_year and user_id = p_user_id)) as liters
  ),
  counts as (
    select
      (select count(*) from base where liters < (select liters from me_val)) as less,
      (select count(*) from base where liters = (select liters from me_val)) as equal,
      (select count(*) from base) as n,
      (select liters from me_val) as my_liters
  )
  select
    case when n = 0 then null else 100.0 * (less + 0.5 * equal) / n end as percentile,
    case when n = 0 then null else greatest(1, round(100 - (100.0 * (less + 0.5 * equal) / n))) end as top_pct,
    my_liters,
    n

  from counts;
$function$
;

CREATE OR REPLACE FUNCTION public.aggregate_notification_analytics_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    target_window timestamptz := date_trunc('hour', timezone('utc', now())) - interval '1 hour';
    aggregate_date text := to_char(target_window, 'YYYY-MM-DD');
    aggregate_hour integer := extract(hour from target_window);
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

    edge_function_url := project_url || '/functions/v1/aggregate-notification-analytics';

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

    if http_response->>'status' = 'error' or (http_response->>'status_code')::integer >= 400 then
        raise exception 'Analytics aggregation failed: %', http_response->>'content';
    end if;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.process_scheduled_notifications_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
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

    edge_function_url := project_url || '/functions/v1/process-scheduled-notifications-fcm';

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

    if http_response->>'status' = 'error' or (http_response->>'status_code')::integer >= 400 then
        raise exception 'FCM notification processing failed: %', http_response->>'content';
    end if;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.token_cleanup_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
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

    edge_function_url := project_url || '/functions/v1/token-maintenance';

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

    if http_response->>'status' = 'error' or (http_response->>'status_code')::integer >= 400 then
        raise exception 'Token cleanup failed: %', http_response->>'content';
    end if;
END;
$function$
;


