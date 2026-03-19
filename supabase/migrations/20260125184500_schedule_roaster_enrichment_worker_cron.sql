-- Schedule roaster enrichment worker cron job

create extension if not exists pg_cron;

create or replace function public.roaster_enrichment_worker_cron()
returns void
language plpgsql
security definer
set search_path = public
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

    edge_function_url := project_url || '/functions/v1/roaster-enrichment-worker';

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

comment on function public.roaster_enrichment_worker_cron() is
  'Invokes the roaster-enrichment-worker Edge Function via pg_net.';

do $cron$
declare
    v_job_id integer;
begin
    select jobid
    into v_job_id
    from cron.job
    where jobname = 'roaster-enrichment-worker'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    select cron.schedule(
        'roaster-enrichment-worker',
        '*/5 * * * *',
        'select public.roaster_enrichment_worker_cron();'
    )
    into v_job_id;
end;
$cron$
language plpgsql;
