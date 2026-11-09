-- Schedule the global_stats insert-silence watchdog.
--
-- The app inserts brews directly into public.global_stats as `authenticated`
-- and catches insert errors with only a local log, so a broken insert path
-- would lose brews silently. The global-stats-insert-watchdog Edge Function
-- emails the operator when no row has been inserted for 120 minutes; this
-- wrapper invokes it every 30 minutes.
--
-- The wrapper mirrors public.roaster_link_scan_cron()
-- (20261029120000_roaster_link_scan_cron.sql): same language/security
-- definer/search_path, same Vault-secret reads, same apikey-with-legacy-
-- fallback header construction (20260708171500_migrate_pgnet_callers_to_apikey.sql),
-- same guarded unschedule/schedule. Deliberate differences:
--   * net.http_post() returns a bigint request id (the request is queued and
--     sent after commit), so it is captured as `request_id bigint`, exactly
--     as the roaster wrapper does per
--     20260916160000_plan035_fix_pgnet_cron_wrapper_response_handling.sql.
--     No HTTP status is knowable here; the function logs its own outcome.
--   * Body is '{}'::jsonb and the pg_net timeout is 30 s (the watchdog does
--     one small query and at most one email).
--   * No service.cleanup_logs insert, unlike the roaster wrapper: this runs
--     48 times a day and a log row per run would grow cleanup_logs without
--     adding information. The function logs its own outcome.
--   * EXECUTE is also granted to postgres, not only service_role (both need
--     it: pg_cron runs as postgres), always after the by-name revokes.
--
-- The function authenticates the request itself (verify_jwt = false in
-- config.toml, like roaster-link-scan), accepting the service-role key as a
-- Bearer token or in `apikey`, or EDGE_FUNCTIONS_API_KEY in `apikey`.

create or replace function public.global_stats_insert_watchdog_cron()
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
    request_id bigint;
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

    -- net.http_post returns a bigint request id. The request is queued, not
    -- sent, so no response is available in this transaction.
    select net.http_post(
        url := project_url || '/functions/v1/global-stats-insert-watchdog',
        body := '{}'::jsonb,
        headers := headers,
        timeout_milliseconds := 30000
    ) into request_id;
end;
$function$;

comment on function public.global_stats_insert_watchdog_cron() is
  'Invokes the global-stats-insert-watchdog Edge Function via pg_net (every 30 minutes) to alert the operator when no brew has been inserted into public.global_stats for 120 minutes.';

-- Only postgres (pg_cron) and service_role may execute this wrapper -- never
-- anon/authenticated via /rest/v1/rpc/. Revoke by name: the project default
-- privileges grant EXECUTE to anon and authenticated as named roles, so a
-- revoke from public alone leaves those grants in place.
revoke execute on function public.global_stats_insert_watchdog_cron() from public;
revoke execute on function public.global_stats_insert_watchdog_cron() from anon;
revoke execute on function public.global_stats_insert_watchdog_cron() from authenticated;
grant execute on function public.global_stats_insert_watchdog_cron() to service_role;
grant execute on function public.global_stats_insert_watchdog_cron() to postgres;

do $cron$
declare
    v_job_id integer;
begin
    select jobid into v_job_id
    from cron.job
    where jobname = 'global-stats-insert-watchdog'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
        'global-stats-insert-watchdog',
        '*/30 * * * *',
        'select public.global_stats_insert_watchdog_cron();'
    );
end;
$cron$
language plpgsql;
