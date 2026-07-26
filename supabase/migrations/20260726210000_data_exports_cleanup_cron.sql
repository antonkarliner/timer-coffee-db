-- Storage-object cleanup for the self-serve user data export (Plan 035, Phase 2).
--
-- 20260726190000_data_export_requests.sql already schedules
-- service.cleanup_expired_data_exports() hourly at minute :15, but that
-- function deliberately purges DB ROWS ONLY: storage.protect_delete (a
-- BEFORE DELETE trigger) blocks direct DELETE on storage.objects, and even
-- overriding it would orphan the object bytes. Stale export zips must
-- therefore be removed through the Storage API instead, which is exactly
-- what the "cleanup" action of the export-user-data Edge Function does (see
-- supabase/functions/export-user-data/index.ts).
--
-- This migration wires that action up to pg_cron. The wrapper function below
-- mirrors public.normalize_bean_origins_cron() exactly (see
-- 20260708171500_migrate_pgnet_callers_to_apikey.sql): same language/security
-- definer/search_path, same Vault-secret reads, same apikey-with-legacy-
-- fallback header construction, same net.http_post + cleanup_logs shape. It
-- is scheduled hourly at minute :20 -- avoiding both the rate_limits cleanup
-- at :00 and the data-export-request-rows cleanup at :15.
--
-- The grants below are applied directly (not as a later "harden" migration)
-- because 20260726193000_harden_data_export_grants.sql and
-- 20260726200000_harden_rate_limits_grants.sql already established this is
-- required for every SECURITY DEFINER cron wrapper in this schema: anon and
-- authenticated must never be able to invoke it via PostgREST RPC.

create or replace function public.cleanup_data_exports_cron()
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
    http_response jsonb;
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

    select net.http_post(
        url := project_url || '/functions/v1/export-user-data',
        body := jsonb_build_object('action', 'cleanup'),
        headers := headers,
        timeout_milliseconds := 300000
    ) into http_response;

    insert into service.cleanup_logs (action, records_affected, details)
    values (
        'export-user-data-cleanup_cron',
        coalesce((http_response->>'removed')::integer, 0),
        jsonb_build_object(
            'edge_function', 'export-user-data',
            'response_code', coalesce((http_response->>'status_code')::integer, 500),
            'executed_at', timezone('utc', now())
        )
    );
end;
$function$;

comment on function public.cleanup_data_exports_cron() is
  'Invokes the export-user-data Edge Function (action=cleanup) via pg_net to purge data-exports storage objects older than 2 hours. Row cleanup for service.data_export_requests is handled separately by service.cleanup_expired_data_exports() (hourly at :15).';

-- Only postgres (pg_cron) and service_role may execute this wrapper -- never
-- anon/authenticated via /rest/v1/rpc/, matching the two prior "harden"
-- migrations for this class of function.
revoke execute on function public.cleanup_data_exports_cron() from public;
revoke execute on function public.cleanup_data_exports_cron() from anon;
revoke execute on function public.cleanup_data_exports_cron() from authenticated;
grant execute on function public.cleanup_data_exports_cron() to service_role;

do $cron$
declare
    v_job_id integer;
begin
    select jobid into v_job_id
    from cron.job
    where jobname = 'cleanup-data-exports-storage'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
        'cleanup-data-exports-storage',
        '20 * * * *',
        'select public.cleanup_data_exports_cron();'
    );
end;
$cron$
language plpgsql;
