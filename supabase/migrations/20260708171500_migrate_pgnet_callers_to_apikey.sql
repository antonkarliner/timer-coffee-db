-- Migrate pg_net edge-function callers from legacy Authorization Bearer JWT to the apikey header
--
-- Background: the legacy `service_role_key` stored in Vault is a JWT-era secret.
-- Since Supabase's move to the new publishable/secret API key format, this legacy
-- JWT is intermittently rejected by the platform with UNAUTHORIZED_LEGACY_JWT,
-- causing pg_cron-driven edge function invocations to fail sporadically.
--
-- Per Supabase's "Migrating to publishable and secret API keys" guide, calls made
-- via pg_net to Edge Functions should send the new-style API key (a `sb_secret_...`
-- key) in the `apikey` header rather than as an `Authorization: Bearer` token.
--
-- This migration updates all 8 pg_cron wrapper functions in `public` to read a new
-- Vault secret `edge_functions_api_key` and, when present, send it via the `apikey`
-- header (omitting Authorization entirely). If that Vault secret has not been
-- created yet, each function falls back automatically to the existing
-- `Authorization: Bearer <service_role_key>` behavior, so this migration is a
-- zero-functional-change no-op until the new secret is provisioned in Vault.
--
-- It also fixes the `check_new_roaster` DB webhook trigger on
-- `public.global_coffee_beans`, which currently calls
-- `supabase_functions.http_request` with no auth headers at all. Since the
-- check-new-roaster Edge Function has verify_jwt enabled, every invocation of that
-- webhook has always been rejected. The trigger is replaced with a plpgsql trigger
-- function that sends the same apikey-with-legacy-fallback headers, and swallows
-- any HTTP failure so it can never abort the triggering insert.

-- 1. aggregate_notification_analytics_cron
create or replace function public.aggregate_notification_analytics_cron()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    api_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
    );
    target_window timestamptz := date_trunc('hour', timezone('utc', now())) - interval '1 hour';
    aggregate_date text := to_char(target_window, 'YYYY-MM-DD');
    aggregate_hour integer := extract(hour from target_window);
    edge_function_url text;
    headers jsonb;
    http_response jsonb;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if cron_secret is null then
        raise exception 'Vault secret cron_job_secret is not set.';
    end if;

    if api_key is null and service_key is null then
        raise exception 'Neither vault secret edge_functions_api_key nor service_role_key is set.';
    end if;

    if api_key is not null then
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', api_key,
            'X-System-Token', cron_secret
        );
    else
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key,
            'X-System-Token', cron_secret
        );
    end if;

    edge_function_url := project_url || '/functions/v1/aggregate-notification-analytics';

    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('date', aggregate_date, 'hour', aggregate_hour),
        headers := headers,
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
end;
$function$;

-- 2. check_new_version_cron
create or replace function public.check_new_version_cron()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  project_url text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
  );
  service_key text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
  );
  api_key text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
  );
  headers jsonb;
begin
  if project_url is null then
    raise exception 'Vault secret supabase_url is not set.';
  end if;

  if api_key is null and service_key is null then
    raise exception 'Neither vault secret edge_functions_api_key nor service_role_key is set.';
  end if;

  if api_key is not null then
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', api_key
    );
  else
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key
    );
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/check-new-version',
    body := jsonb_build_object('trigger', 'pg_cron', 'timestamp', timezone('utc', now())),
    headers := headers,
    timeout_milliseconds := 30000
  );
end;
$function$;

-- 3. normalize_bean_origins_cron
create or replace function public.normalize_bean_origins_cron()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    api_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
    );
    headers jsonb;
    pending integer;
    http_response jsonb;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;
    if api_key is null and service_key is null then
        raise exception 'Neither vault secret edge_functions_api_key nor service_role_key is set.';
    end if;

    -- Skip the HTTP call entirely when there is nothing new to normalize.
    select count(*) into pending
    from (
        select 1
        from public.user_coffee_beans ucb
        where nullif(btrim(ucb.origin), '') is not null
          and not exists (
              select 1 from public.bean_origin_normalizations n
              where n.origin_key = public.normalize_origin_key(ucb.origin)
          )
        group by public.normalize_origin_key(ucb.origin)
        limit 1
    ) s;

    if coalesce(pending, 0) = 0 then
        return;
    end if;

    if api_key is not null then
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', api_key
        );
    else
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
        );
    end if;

    select net.http_post(
        url := project_url || '/functions/v1/normalize-bean-origins',
        body := jsonb_build_object('backfill', true, 'limit', 100),
        headers := headers,
        timeout_milliseconds := 300000
    ) into http_response;

    insert into service.cleanup_logs (action, records_affected, details)
    values (
        'normalize-bean-origins_cron',
        0,
        jsonb_build_object(
            'edge_function', 'normalize-bean-origins',
            'response_code', coalesce((http_response->>'status_code')::integer, 500),
            'executed_at', timezone('utc', now())
        )
    );
end;
$function$;

-- 4. process_app_release_notifications_cron
create or replace function public.process_app_release_notifications_cron()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  project_url text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
  );
  cron_secret text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
  );
  service_key text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
  );
  api_key text := (
    select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
  );
  headers jsonb;
begin
  if project_url is null then
    raise exception 'Vault secret supabase_url is not set.';
  end if;

  if cron_secret is null then
    raise exception 'Vault secret cron_job_secret is not set.';
  end if;

  if api_key is null and service_key is null then
    raise exception 'Neither vault secret edge_functions_api_key nor service_role_key is set.';
  end if;

  if api_key is not null then
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', api_key,
      'X-System-Token', cron_secret
    );
  else
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || service_key,
      'X-System-Token', cron_secret
    );
  end if;

  perform net.http_post(
    url := project_url || '/functions/v1/process-app-release-notifications',
    body := jsonb_build_object('trigger', 'pg_cron', 'timestamp', timezone('utc', now())),
    headers := headers,
    timeout_milliseconds := 300000
  );
end;
$function$;

-- 5. process_live_activity_events_cron
create or replace function public.process_live_activity_events_cron()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    api_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
    );
    edge_function_url text;
    headers jsonb;
    http_response jsonb;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if cron_secret is null then
        raise exception 'Vault secret cron_job_secret is not set.';
    end if;

    if api_key is null and service_key is null then
        raise exception 'Neither vault secret edge_functions_api_key nor service_role_key is set.';
    end if;

    if api_key is not null then
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', api_key,
            'X-System-Token', cron_secret
        );
    else
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key,
            'X-System-Token', cron_secret
        );
    end if;

    edge_function_url := project_url || '/functions/v1/process-live-activity-events-fcm';

    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('timestamp', now()),
        headers := headers,
        timeout_milliseconds := 300000
    ) into http_response;

    if (http_response ? 'status') and http_response->>'status' = 'error' then
        raise exception 'Live activity event processing failed: %', http_response->>'content';
    end if;

    if (http_response ? 'status_code') and (http_response->>'status_code')::integer >= 400 then
        raise exception 'Live activity event processing failed with status code %', http_response->>'status_code';
    end if;
end;
$function$;

-- 6. process_scheduled_notifications_cron
create or replace function public.process_scheduled_notifications_cron()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    api_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
    );
    edge_function_url text;
    headers jsonb;
    http_response jsonb;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if cron_secret is null then
        raise exception 'Vault secret cron_job_secret is not set.';
    end if;

    if api_key is null and service_key is null then
        raise exception 'Neither vault secret edge_functions_api_key nor service_role_key is set.';
    end if;

    if api_key is not null then
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', api_key,
            'X-System-Token', cron_secret
        );
    else
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key,
            'X-System-Token', cron_secret
        );
    end if;

    edge_function_url := project_url || '/functions/v1/process-scheduled-notifications-fcm';

    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('timestamp', now()),
        headers := headers,
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
end;
$function$;

-- 7. roaster_enrichment_worker_cron
create or replace function public.roaster_enrichment_worker_cron()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    api_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
    );
    edge_function_url text;
    headers jsonb;
    http_response jsonb;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if cron_secret is null then
        raise exception 'Vault secret cron_job_secret is not set.';
    end if;

    if api_key is null and service_key is null then
        raise exception 'Neither vault secret edge_functions_api_key nor service_role_key is set.';
    end if;

    if api_key is not null then
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', api_key,
            'X-System-Token', cron_secret
        );
    else
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key,
            'X-System-Token', cron_secret
        );
    end if;

    edge_function_url := project_url || '/functions/v1/roaster-enrichment-worker';

    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('timestamp', now()),
        headers := headers,
        timeout_milliseconds := 300000
    ) into http_response;

    insert into service.cleanup_logs (action, records_affected, details)
    values (
        'roaster-enrichment-worker_cron',
        coalesce((http_response->>'job_id')::integer, 0),
        jsonb_build_object(
            'edge_function', 'roaster-enrichment-worker',
            'status', coalesce((http_response->>'status'), 'unknown'),
            'response_code', coalesce((http_response->>'status_code')::integer, 500),
            'executed_at', timezone('utc', now())
        )
    );

    if http_response->>'status' = 'error' or (http_response->>'status_code')::integer >= 400 then
        raise exception 'Roaster enrichment worker failed: %', http_response->>'content';
    end if;
end;
$function$;

-- 8. token_cleanup_cron
create or replace function public.token_cleanup_cron()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    cron_secret text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'cron_job_secret'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    api_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
    );
    edge_function_url text;
    headers jsonb;
    http_response jsonb;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;

    if cron_secret is null then
        raise exception 'Vault secret cron_job_secret is not set.';
    end if;

    if api_key is null and service_key is null then
        raise exception 'Neither vault secret edge_functions_api_key nor service_role_key is set.';
    end if;

    if api_key is not null then
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', api_key,
            'X-System-Token', cron_secret
        );
    else
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key,
            'X-System-Token', cron_secret
        );
    end if;

    edge_function_url := project_url || '/functions/v1/token-maintenance';

    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('action', 'cleanup', 'maxAgeDays', 90),
        headers := headers,
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
end;
$function$;

-- 9. Fix the check_new_roaster DB webhook, which currently sends no auth headers at
-- all and is always rejected by the check-new-roaster Edge Function (verify_jwt = true).
create or replace function public.check_new_roaster_webhook()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    api_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
    );
    headers jsonb;
begin
    if project_url is null then
        return new;
    end if;

    if api_key is not null then
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', api_key
        );
    else
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
        );
    end if;

    begin
        perform net.http_post(
            url := project_url || '/functions/v1/check-new-roaster',
            body := jsonb_build_object('type', TG_OP, 'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'record', row_to_json(NEW)),
            headers := headers,
            timeout_milliseconds := 1000
        );
    exception when others then
        null;
    end;

    return new;
end;
$function$;

drop trigger if exists check_new_roaster on public.global_coffee_beans;

create trigger check_new_roaster
    after insert on public.global_coffee_beans
    for each row execute function public.check_new_roaster_webhook();
