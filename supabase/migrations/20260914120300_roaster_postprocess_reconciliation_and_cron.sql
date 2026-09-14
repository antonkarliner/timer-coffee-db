-- Reconciliation + the pg_cron dispatcher for the roaster post-processing
-- ledger (table + RPCs in 20260914120000; enqueue triggers in 20260914120200).
--
--   service.reconcile_roaster_postprocessing(p_enqueue := false)
--       Reports every invariant violation on the roaster post-processing
--       pipeline; with p_enqueue := true it idempotently enqueues the fixable
--       ones (never for terminal 'failed' jobs).
--
--   public.roaster_postprocess_dispatch_cron()
--       Scheduled every minute. Recovers stale locks, and wakes the
--       roaster-postprocess-worker Edge Function via pg_net only when a job
--       is actually runnable. A failed wake-up must never touch the jobs:
--       pg_net is fire-and-forget, so HTTP failures (including the ~1-2%
--       UNAUTHORIZED_LEGACY_JWT rejections while edge_functions_api_key is
--       not yet provisioned in Vault) leave everything in 'queued' and the
--       next tick retries.
--
-- The auth-header construction is copied verbatim from
-- 20260708171500_migrate_pgnet_callers_to_apikey.sql (see e.g. its
-- roaster_enrichment_worker_cron): read BOTH Vault secrets, prefer the
-- new-style key as the `apikey` header with Authorization OMITTED, fall back
-- to `Authorization: Bearer <service_role_key>`.

--------------------------------------------------------------------------------
-- 1) Reconciliation
--------------------------------------------------------------------------------

create or replace function service.reconcile_roaster_postprocessing(
    p_enqueue boolean default false
)
returns table (violation text, roaster_id bigint, detail text)
language plpgsql
security definer
set search_path = service, public, extensions, pg_catalog
as $function$
begin
    if coalesce(p_enqueue, false) then
        -- source_without_mirror -> mirror_logo
        perform service.enqueue_roaster_job(cr.id, 'mirror_logo', cr.roaster_logo_url)
        from public.coffee_roasters cr
        where cr.roaster_logo_url is not null
          and cr.roaster_logo_mirror_url is null;

        -- mirror_without_color -> extract_color
        perform service.enqueue_roaster_job(cr.id, 'extract_color', cr.roaster_logo_mirror_url)
        from public.coffee_roasters cr
        where cr.roaster_logo_mirror_url is not null
          and cr.dominant_color_hex is null
          and not exists (
              -- A succeeded extract_color job for the CURRENT mirror revision
              -- means we already looked and legitimately found no colour (the
              -- documented fully-transparent rule). Measured case: roaster 1567
              -- "Bruno Brown Cafe", whose source is a 2.45 MB animated GIF
              -- whose first frame has zero opaque pixels. Without this guard
              -- such a roaster is reported as a violation forever and can never
              -- be fixed, which breaks the "reconciliation returns no
              -- violations" acceptance criterion.
              select 1
              from service.roaster_postprocess_jobs j
              where j.roaster_id = cr.id
                and j.kind = 'extract_color'
                and j.state = 'succeeded'
                and j.source_revision = cr.roaster_logo_mirror_url
          );

        -- unattached_exact_bean -> attach_beans (one idempotent job per
        -- roaster that has exact unambiguous unattached matches)
        perform service.enqueue_roaster_job(v.rid, 'attach_beans', v.revision)
        from (
            with owners as (
                select cr.id, nullif(lower(public.immutable_unaccent(trim(cr.roaster_name))), '') as term
                from public.coffee_roasters cr
                union all
                select cr.id, nullif(lower(public.immutable_unaccent(trim(a.alias))), '') as term
                from public.coffee_roasters cr
                cross join lateral regexp_split_to_table(coalesce(cr.aliases, ''), '\s*,\s*') as a(alias)
            ),
            unambiguous_owner as (
                select o.term, min(o.id) as owner_id
                from owners o
                where o.term is not null
                group by o.term
                having count(distinct o.id) = 1
            )
            select distinct
                   u.owner_id as rid,
                   coalesce(cr.normalized_name, '') || '|' || coalesce(cr.normalized_aliases, '') as revision
            from unambiguous_owner u
            join public.global_coffee_beans g
              on g.coffee_roaster_id is null
             and g.normalized_roaster = u.term
            join public.coffee_roasters cr
              on cr.id = u.owner_id
        ) v;

        -- missing_profile is NOT enqueued: no ledger job kind creates
        -- roaster_profiles (that remains the trg_create_roaster_profile
        -- trigger's job). terminal_job is never enqueued (operator action:
        -- service.requeue_roaster_job).
    end if;

    return query
        -- Roasters without a profile row.
        select 'missing_profile'::text, cr.id, 'no row in public.roaster_profiles'::text
        from public.coffee_roasters cr
        where not exists (
            select 1 from public.roaster_profiles rp where rp.coffee_roaster_id = cr.id
        )

        union all

        select 'source_without_mirror'::text, cr.id, 'roaster_logo_url=' || cr.roaster_logo_url
        from public.coffee_roasters cr
        where cr.roaster_logo_url is not null
          and cr.roaster_logo_mirror_url is null

        union all

        select 'mirror_without_color'::text, cr.id, 'roaster_logo_mirror_url=' || cr.roaster_logo_mirror_url
        from public.coffee_roasters cr
        where cr.roaster_logo_mirror_url is not null
          and cr.dominant_color_hex is null
          and not exists (
              -- A succeeded extract_color job for the CURRENT mirror revision
              -- means we already looked and legitimately found no colour (the
              -- documented fully-transparent rule). Measured case: roaster 1567
              -- "Bruno Brown Cafe", whose source is a 2.45 MB animated GIF
              -- whose first frame has zero opaque pixels. Without this guard
              -- such a roaster is reported as a violation forever and can never
              -- be fixed, which breaks the "reconciliation returns no
              -- violations" acceptance criterion.
              select 1
              from service.roaster_postprocess_jobs j
              where j.roaster_id = cr.id
                and j.kind = 'extract_color'
                and j.state = 'succeeded'
                and j.source_revision = cr.roaster_logo_mirror_url
          )

        union all

        -- One row per (roaster, term) that still owns unattached exact beans.
        select 'unattached_exact_bean'::text,
               n.rid,
               n.term || ' (' || n.unattached_count || ' unattached bean(s))'
        from (
            with owners as (
                select cr.id, nullif(lower(public.immutable_unaccent(trim(cr.roaster_name))), '') as term
                from public.coffee_roasters cr
                union all
                select cr.id, nullif(lower(public.immutable_unaccent(trim(a.alias))), '') as term
                from public.coffee_roasters cr
                cross join lateral regexp_split_to_table(coalesce(cr.aliases, ''), '\s*,\s*') as a(alias)
            ),
            unambiguous_owner as (
                select o.term, min(o.id) as owner_id
                from owners o
                where o.term is not null
                group by o.term
                having count(distinct o.id) = 1
            )
            select u.owner_id as rid,
                   u.term,
                   count(g.id)::int as unattached_count
            from unambiguous_owner u
            join public.global_coffee_beans g
              on g.coffee_roaster_id is null
             and g.normalized_roaster = u.term
            group by u.owner_id, u.term
        ) n

        union all

        -- Terminal failures need operator attention (detail = kind + last_error).
        select 'terminal_job'::text,
               j.roaster_id,
               j.kind || coalesce(': ' || left(j.last_error, 500), '')
        from service.roaster_postprocess_jobs j
        where j.state = 'failed'

        order by 1, 2, 3;
end;
$function$;

revoke execute on function service.reconcile_roaster_postprocessing(boolean) from public;
revoke execute on function service.reconcile_roaster_postprocessing(boolean) from anon;
revoke execute on function service.reconcile_roaster_postprocessing(boolean) from authenticated;
grant execute on function service.reconcile_roaster_postprocessing(boolean) to service_role;
grant execute on function service.reconcile_roaster_postprocessing(boolean) to postgres;

--------------------------------------------------------------------------------
-- 2) Dispatcher
--------------------------------------------------------------------------------

create or replace function public.roaster_postprocess_dispatch_cron()
returns void
language plpgsql
security definer
set search_path to 'public', 'service', 'pg_catalog'
as $function$
declare
    -- Fixed key so overlapping cron ticks collide here instead of on the
    -- ledger. Arbitrary constant, unique in this project.
    c_advisory_lock_key constant bigint := 742026091401;
    v_runnable          integer := 0;
    v_url               text;
    v_api_key           text;
    v_service_key       text;
    v_headers           jsonb;
    v_http_response     jsonb;
    v_http_error        text;
begin
    if not pg_try_advisory_lock(c_advisory_lock_key) then
        -- A previous tick is still dispatching; skip this run quietly.
        return;
    end if;

    begin
        -- Re-queue jobs whose worker died mid-flight before deciding whether
        -- anything is runnable.
        perform service.recover_stale_roaster_jobs();

        select count(*)::int into v_runnable
        from service.roaster_postprocess_jobs
        where state in ('queued', 'retry_wait')
          and run_after <= now();

        if coalesce(v_runnable, 0) > 0 then
            v_url := (
                select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url'
            );
            v_api_key := (
                select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_api_key'
            );
            v_service_key := (
                select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
            );

            if v_url is null then
                raise exception 'Vault secret supabase_url is not set.';
            end if;
            if v_api_key is null and v_service_key is null then
                raise exception 'Neither vault secret edge_functions_api_key nor service_role_key is set.';
            end if;

            -- apikey-with-legacy-fallback, copied from
            -- 20260708171500_migrate_pgnet_callers_to_apikey.sql: prefer the
            -- new-style key in the `apikey` header and OMIT Authorization
            -- entirely; otherwise fall back to the legacy Bearer JWT.
            if v_api_key is not null then
                v_headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'apikey', v_api_key
                );
            else
                v_headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'Authorization', 'Bearer ' || v_service_key
                );
            end if;

            -- pg_net enqueues the request and performs it after commit, so an
            -- HTTP-level failure (e.g. UNAUTHORIZED_LEGACY_JWT on the legacy
            -- fallback path) cannot abort this transaction and leaves every
            -- job untouched in 'queued' -- the next tick wakes the worker
            -- again. The handler below only guards queue-time errors.
            begin
                select net.http_post(
                    url := v_url || '/functions/v1/roaster-postprocess-worker',
                    body := '{}'::jsonb,
                    headers := v_headers,
                    timeout_milliseconds := 300000
                ) into v_http_response;
            exception when others then
                v_http_error := sqlerrm;
            end;

            if v_http_error is not null then
                begin
                    insert into service.cleanup_logs (action, records_affected, details)
                    values (
                        'roaster-postprocess-dispatch',
                        coalesce(v_runnable, 0),
                        jsonb_build_object(
                            'error', v_http_error,
                            'executed_at', timezone('utc', now())
                        )
                    );
                exception when others then
                    -- service.cleanup_logs is not created by any migration in
                    -- this repo; keep from-scratch replays alive and still
                    -- surface the failure in the Postgres log.
                    raise warning 'roaster-postprocess-dispatch: wake-up POST failed: %', v_http_error;
                end;
            end if;
        end if;
    exception when others then
        -- Never leave the guard lock behind on an unexpected error.
        perform pg_advisory_unlock(c_advisory_lock_key);
        raise;
    end;

    perform pg_advisory_unlock(c_advisory_lock_key);
end;
$function$;

-- The dispatcher is cron/service machinery: never callable by anon or
-- authenticated via PostgREST.
revoke execute on function public.roaster_postprocess_dispatch_cron() from public;
revoke execute on function public.roaster_postprocess_dispatch_cron() from anon;
revoke execute on function public.roaster_postprocess_dispatch_cron() from authenticated;
grant execute on function public.roaster_postprocess_dispatch_cron() to service_role;

comment on function public.roaster_postprocess_dispatch_cron() is
  'Per-minute pg_cron dispatcher: recovers stale roaster post-processing jobs and wakes the roaster-postprocess-worker Edge Function only when work is runnable.';

--------------------------------------------------------------------------------
-- 3) Schedule (guarded unschedule keeps the migration replayable)
--------------------------------------------------------------------------------

do $cron$
declare
    v_job_id integer;
begin
    select jobid into v_job_id
    from cron.job
    where jobname = 'roaster-postprocess-dispatch'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
        'roaster-postprocess-dispatch',
        '* * * * *',
        'select public.roaster_postprocess_dispatch_cron();'
    );
end;
$cron$
language plpgsql;
