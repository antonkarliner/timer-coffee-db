-- Phase 4: schedule the daily roaster link scan.
--
-- The scan itself (Google Web Risk lookups, quarantine, emails) is the
-- roaster-link-scan Edge Function; the database side it calls
-- (service.roaster_link_scan_batch, service.quarantine_roaster_link,
-- service.mark_roaster_links_checked) is 20261029111556_roaster_link_quarantine.sql.
--
-- The wrapper mirrors public.cleanup_data_exports_cron()
-- (20260726210000_data_exports_cleanup_cron.sql): same language/security
-- definer/search_path, same Vault-secret reads, same apikey-with-legacy-
-- fallback header construction (20260708171500_migrate_pgnet_callers_to_apikey.sql),
-- same net.http_post + cleanup_logs shape, same grants and guarded
-- unschedule/schedule. Two deliberate differences, both taken from later fixes
-- to this family of wrappers:
--   * net.http_post() returns a bigint request id (the request is queued and
--     sent after commit), so it is captured as `request_id bigint` and logged
--     as such, exactly as 20260916160000_plan035_fix_pgnet_cron_wrapper_response_handling.sql
--     does. No HTTP status or scan counts are knowable here; the function logs
--     its own summary.
--   * The cleanup_logs insert is wrapped, as in 20260914120300 and
--     20260917210000: service.cleanup_logs is not created by any migration in
--     this repo, and a failed insert would otherwise roll back the queued
--     request with it.
--
-- The function authenticates the request itself (verify_jwt = false in
-- config.toml, like roaster-postprocess-worker), accepting the service-role
-- key as a Bearer token or in `apikey`, or EDGE_FUNCTIONS_API_KEY in `apikey`.
--
-- Daily at 03:17 UTC, 300 pages per run (the function caps a run at 1000).

create or replace function public.roaster_link_scan_cron()
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
        url := project_url || '/functions/v1/roaster-link-scan',
        body := jsonb_build_object('limit', 300),
        headers := headers,
        timeout_milliseconds := 300000
    ) into request_id;

    begin
        insert into service.cleanup_logs (action, records_affected, details)
        values (
            'roaster-link-scan_cron',
            0,
            jsonb_build_object(
                'edge_function', 'roaster-link-scan',
                'limit', 300,
                'pg_net_request_id', request_id,
                'note', 'pg_net queues asynchronously; the HTTP outcome and the scan counts are not knowable here. Read net._http_response by pg_net_request_id.',
                'executed_at', timezone('utc', now())
            )
        );
    exception when others then
        raise warning 'roaster-link-scan_cron: cleanup_logs write failed: %', sqlerrm;
    end;
end;
$function$;

comment on function public.roaster_link_scan_cron() is
  'Invokes the roaster-link-scan Edge Function via pg_net (daily 03:17 UTC, limit 300) to re-check roaster page links with Google Web Risk and quarantine flagged ones.';

-- Only postgres (pg_cron) and service_role may execute this wrapper -- never
-- anon/authenticated via /rest/v1/rpc/.
revoke execute on function public.roaster_link_scan_cron() from public;
revoke execute on function public.roaster_link_scan_cron() from anon;
revoke execute on function public.roaster_link_scan_cron() from authenticated;
grant execute on function public.roaster_link_scan_cron() to service_role;

do $cron$
declare
    v_job_id integer;
begin
    select jobid into v_job_id
    from cron.job
    where jobname = 'roaster-link-scan'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
        'roaster-link-scan',
        '17 3 * * *',
        'select public.roaster_link_scan_cron();'
    );
end;
$cron$
language plpgsql;
