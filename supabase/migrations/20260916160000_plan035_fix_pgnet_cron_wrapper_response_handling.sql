-- Plan 035 §2: fix `'unknown'::integer` in two pg_net cron wrappers
--
-- `public.aggregate_notification_analytics_cron()` and `public.token_cleanup_cron()`
-- both contained this line:
--
--     'response_code', COALESCE((http_response->>'status_code'), 'unknown')::integer,
--
-- The cast binds to the whole COALESCE, not to its first branch, so whenever
-- `status_code` is absent the expression evaluates `'unknown'::integer` and raises
-- `invalid input syntax for type integer: "unknown"`.
--
-- `status_code` is *always* absent. `net.http_post()` returns a bigint request id,
-- not a response object: it queues the request and returns immediately. Both
-- functions captured that bigint into a variable declared `jsonb`, so
-- `http_response` held a bare JSON number and every `->>` on it returned NULL.
-- The COALESCE therefore always fell through to 'unknown' and the insert always
-- raised.
--
-- Because `net.http_post()` enqueues into `net.http_request_queue` in the calling
-- transaction, aborting the function rolled the queue row back too. The edge
-- functions were never invoked. Measured on production 2026-09-16: 182 consecutive
-- failed runs of `aggregate-notification-analytics` and 7 of `cleanup-invalid-tokens`
-- (the full retained history of `cron.job_run_details`), zero rows in
-- `service.notification_analytics`, and zero rows in `service.cleanup_logs` for
-- either the `analytics_aggregation_cron` or `token_cleanup_cron` action.
--
-- Fix, applied identically to both:
--   1. Capture the return value as `request_id bigint`.
--   2. Log the request id. Drop the fabricated `status` / `response_code` /
--      `content` fields — pg_net cannot supply them at call time. A caller that
--      needs the outcome must read `net._http_response` later, by request id.
--   3. Delete the `if ... raise exception` block that followed. It was dead code:
--      both its operands were always NULL.
--   4. Write an honest `records_affected`. `token_cleanup_cron` used
--      `COALESCE((http_response->>'deleted')::integer, 0)`, which was always 0,
--      and `aggregate_notification_analytics_cron` hardcoded 1. Neither count is
--      knowable at queue time, so both now write 0 and say why in `details`.
--
-- Everything else is preserved verbatim: SECURITY DEFINER, owner, `search_path`,
-- the Vault secret lookups, the apikey-with-legacy-Bearer-fallback header shape,
-- the request bodies and the 300s timeout.
--
-- Grants are deliberately untouched. Both functions currently sit at
-- {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}.
-- CREATE OR REPLACE FUNCTION preserves the existing ACL, so this migration does not
-- change their exposure in either direction. EXECUTE on the `public` cron wrappers
-- is plan 031's surface and it owns that classification. Note for 031: both of
-- these are cron-only, invoked as `postgres`.

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
    request_id bigint;
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

    -- net.http_post returns a bigint request id. The request is queued, not sent,
    -- so no response is available in this transaction.
    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('date', aggregate_date, 'hour', aggregate_hour),
        headers := headers,
        timeout_milliseconds := 300000
    ) into request_id;

    insert into service.cleanup_logs (action, records_affected, details)
    values (
        'analytics_aggregation_cron',
        0,
        jsonb_build_object(
            'edge_function', 'aggregate-notification-analytics',
            'date', aggregate_date,
            'hour', aggregate_hour,
            'pg_net_request_id', request_id,
            'note', 'pg_net queues asynchronously; the HTTP outcome and the affected-row count are not knowable here. Read net._http_response by pg_net_request_id.',
            'executed_at', timezone('utc', now())
        )
    );
end;
$function$;

-- 2. token_cleanup_cron
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
    request_id bigint;
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

    -- net.http_post returns a bigint request id. The request is queued, not sent,
    -- so the deleted-token count is not available in this transaction.
    select net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('action', 'cleanup', 'maxAgeDays', 90),
        headers := headers,
        timeout_milliseconds := 300000
    ) into request_id;

    insert into service.cleanup_logs (action, records_affected, details)
    values (
        'token_cleanup_cron',
        0,
        jsonb_build_object(
            'edge_function', 'token-maintenance',
            'max_age_days', 90,
            'pg_net_request_id', request_id,
            'note', 'pg_net queues asynchronously; the HTTP outcome and the deleted-token count are not knowable here. Read net._http_response by pg_net_request_id.',
            'executed_at', timezone('utc', now())
        )
    );
end;
$function$;
