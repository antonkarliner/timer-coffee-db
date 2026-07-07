-- Keep the bean-origin normalization cache fresh: hourly, hand any newly-entered
-- (still un-cached) origins to the normalize-bean-origins edge function in
-- backfill mode. The function self-pulls the work and returns early when there
-- is nothing to do, so an idle run is cheap. Mirrors the pg_net + vault-secret
-- pattern of roaster_enrichment_worker_cron.

create extension if not exists pg_cron;

create or replace function public.normalize_bean_origins_cron()
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
    project_url text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
    );
    service_key text := (
        select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
    );
    pending integer;
    http_response jsonb;
begin
    if project_url is null then
        raise exception 'Vault secret supabase_url is not set.';
    end if;
    if service_key is null then
        raise exception 'Vault secret service_role_key is not set.';
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

    select net.http_post(
        url := project_url || '/functions/v1/normalize-bean-origins',
        body := jsonb_build_object('backfill', true, 'limit', 100),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || service_key
        ),
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

comment on function public.normalize_bean_origins_cron() is
  'Invokes the normalize-bean-origins Edge Function (backfill mode) via pg_net to cache ISO codes for newly-entered bean origins.';

do $cron$
declare
    v_job_id integer;
begin
    select jobid into v_job_id
    from cron.job
    where jobname = 'normalize-bean-origins'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
        'normalize-bean-origins',
        '0 * * * *',
        'select public.normalize_bean_origins_cron();'
    );
end;
$cron$
language plpgsql;
