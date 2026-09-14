-- Durable roaster post-processing job ledger.
--
-- Replaces trigger-inline network calls and heavy scans on the
-- public.coffee_roasters write path with a durable queue processed by the
-- roaster-postprocess-worker Edge Function:
--
--   mirror_logo   -> mirror roaster_logo_url into storage
--   extract_color -> extract dominant colour from the mirrored logo
--   attach_beans  -> attach previously-unlinked public.global_coffee_beans
--
-- Lifecycle: queued -> running -> succeeded | (failed | retry_wait -> running ...)
--
-- source_revision is the identity of the INPUT the job is for:
--   mirror_logo   -> coffee_roasters.roaster_logo_url
--   extract_color -> coffee_roasters.roaster_logo_mirror_url
--   attach_beans  -> coalesce(normalized_name,'') || '|' || coalesce(normalized_aliases,'')
--
-- This migration ADDS MACHINERY ONLY: table, indexes, RLS, grants, and the
-- queue RPCs. It does not modify any existing trigger or function, so it is
-- safe to apply while the legacy roaster triggers are still running.
--
-- updated_at is maintained by the repo-standard service.set_updated_at()
-- trigger (see 20251109223000_create_service_fcm_core.sql).
--
-- Queue RPCs are SECURITY DEFINER with a pinned search_path. They are
-- executable by service_role (the edge worker) and postgres (the pg_cron
-- dispatcher, and the definer-owned public trigger functions that enqueue).
-- anon and authenticated get nothing.

create schema if not exists service;

--------------------------------------------------------------------------------
-- 1) Ledger table
--------------------------------------------------------------------------------

create table if not exists service.roaster_postprocess_jobs (
    id              bigint generated always as identity primary key,
    roaster_id      bigint not null references public.coffee_roasters(id) on delete cascade,
    kind            text not null check (kind in ('mirror_logo', 'extract_color', 'attach_beans')),
    source_revision text not null,
    state           text not null default 'queued'
                    check (state in ('queued', 'running', 'retry_wait', 'succeeded', 'failed')),
    attempts        int not null default 0,
    max_attempts    int not null default 8,
    run_after       timestamptz not null default now(),
    locked_by       text,
    locked_at       timestamptz,
    last_error      text,
    error_class     text,
    correlation_id  uuid not null default gen_random_uuid(),
    payload         jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    finished_at     timestamptz
);

comment on table service.roaster_postprocess_jobs is
  'Durable ledger of roaster post-processing jobs (logo mirror, colour extraction, bean attachment).';
comment on column service.roaster_postprocess_jobs.source_revision is
  'Identity of the input this job is for: mirror_logo -> roaster_logo_url; extract_color -> roaster_logo_mirror_url; attach_beans -> normalized_name || ''|'' || normalized_aliases.';
comment on column service.roaster_postprocess_jobs.error_class is
  'Coarse error taxonomy, e.g. source_too_large, http_5xx, unsupported_format.';

--------------------------------------------------------------------------------
-- 2) Indexes
--------------------------------------------------------------------------------

-- One active job per (roaster, kind, input revision). This is a partial unique
-- INDEX rather than a table constraint: PostgreSQL cannot declare a partial
-- unique constraint. service.enqueue_roaster_job targets it via ON CONFLICT
-- inference with the identical WHERE predicate.
create unique index if not exists uniq_roaster_job_active
    on service.roaster_postprocess_jobs (roaster_id, kind, source_revision)
    where state in ('queued', 'running', 'retry_wait');

-- Runnable-job lookup for the worker/dispatcher.
create index if not exists idx_roaster_postprocess_jobs_runnable
    on service.roaster_postprocess_jobs (kind, run_after)
    where state in ('queued', 'retry_wait');

create index if not exists idx_roaster_postprocess_jobs_roaster_kind
    on service.roaster_postprocess_jobs (roaster_id, kind);

--------------------------------------------------------------------------------
-- 3) RLS + grants
--------------------------------------------------------------------------------

-- RLS is enabled; there is deliberately NO permissive policy for anon or
-- authenticated. The service_role policy mirrors the existing convention for
-- service-schema tables (see service.roaster_dominant_color_backfill in
-- 20260407000000_add_roaster_dominant_color.sql).
alter table service.roaster_postprocess_jobs enable row level security;

drop policy if exists service_role_roaster_postprocess_jobs
    on service.roaster_postprocess_jobs;

create policy service_role_roaster_postprocess_jobs
    on service.roaster_postprocess_jobs
    for all
    to service_role
    using (true)
    with check (true);

grant usage on schema service to service_role;

grant select, insert, update, delete on service.roaster_postprocess_jobs to service_role;

--------------------------------------------------------------------------------
-- 4) updated_at maintenance (repo convention)
--------------------------------------------------------------------------------

drop trigger if exists trg_roaster_postprocess_jobs_set_updated_at
    on service.roaster_postprocess_jobs;

create trigger trg_roaster_postprocess_jobs_set_updated_at
    before update on service.roaster_postprocess_jobs
    for each row execute function service.set_updated_at();

--------------------------------------------------------------------------------
-- 5) RPC 1: enqueue (idempotent per input revision)
--------------------------------------------------------------------------------

-- Returns the job id, or NULL for a no-op:
--   * p_source_revision null/empty -> NULL
--   * a 'succeeded' row exists for the same (roaster, kind, revision) and
--     p_force is false -> NULL (never redo completed work)
--   * an active row already exists -> the existing active row's id
--
-- Single statement so the succeeded-check, the insert, and the fallback
-- select share one snapshot under concurrent enqueues. The ON CONFLICT target
-- infers the partial unique index uniq_roaster_job_active via the identical
-- WHERE predicate (ON CONFLICT ON CONSTRAINT is not possible: a partial
-- unique index is not a constraint).
create or replace function service.enqueue_roaster_job(
    p_roaster_id bigint,
    p_kind text,
    p_source_revision text,
    p_run_after timestamptz default now(),
    p_force boolean default false
)
returns bigint
language sql
security definer
set search_path = service, public, extensions, pg_catalog
as $function$
with candidate as (
    select p_roaster_id as roaster_id, p_kind as kind, p_source_revision as source_revision
    where p_roaster_id is not null
      and p_kind is not null
      and p_source_revision is not null
      and btrim(p_source_revision) <> ''
),
ins as (
    insert into service.roaster_postprocess_jobs as j
        (roaster_id, kind, source_revision, run_after)
    select c.roaster_id, c.kind, c.source_revision, coalesce(p_run_after, now())
    from candidate c
    where p_force is true
       or not exists (
            select 1
            from service.roaster_postprocess_jobs s
            where s.roaster_id = c.roaster_id
              and s.kind = c.kind
              and s.source_revision = c.source_revision
              and s.state = 'succeeded'
       )
    on conflict (roaster_id, kind, source_revision)
        where state in ('queued', 'running', 'retry_wait')
        do nothing
    returning j.id
),
existing as (
    select j.id
    from candidate c
    join service.roaster_postprocess_jobs j
      on j.roaster_id = c.roaster_id
     and j.kind = c.kind
     and j.source_revision = c.source_revision
     and j.state in ('queued', 'running', 'retry_wait')
    where p_force is true
       or not exists (
            select 1
            from service.roaster_postprocess_jobs s
            where s.roaster_id = c.roaster_id
              and s.kind = c.kind
              and s.source_revision = c.source_revision
              and s.state = 'succeeded'
       )
)
select id from ins
union all
select id from existing
where not exists (select 1 from ins)
order by 1
limit 1;
$function$;

--------------------------------------------------------------------------------
-- 6) RPC 2: claim (FOR UPDATE SKIP LOCKED; returns the UPDATED rows)
--------------------------------------------------------------------------------

create or replace function service.claim_roaster_jobs(
    p_kinds text[],
    p_limit integer,
    p_owner text
)
returns setof service.roaster_postprocess_jobs
language sql
security definer
set search_path = service, public, extensions, pg_catalog
as $function$
with candidates as (
    select j.id
    from service.roaster_postprocess_jobs j
    where j.state in ('queued', 'retry_wait')
      and j.run_after <= now()
      and p_kinds is not null
      and j.kind = any (p_kinds)
    order by j.run_after, j.id
    limit coalesce(p_limit, 25)
    for update of j skip locked
),
claimed as (
    update service.roaster_postprocess_jobs j
    set state = 'running',
        locked_by = p_owner,
        locked_at = now(),
        attempts = j.attempts + 1
    from candidates c
    where j.id = c.id
    returning j.*
)
select * from claimed order by id;
$function$;

--------------------------------------------------------------------------------
-- 7) RPC 3: finish (owner-checked; exponential backoff with jitter on retry)
--------------------------------------------------------------------------------

create or replace function service.finish_roaster_job(
    p_job_id bigint,
    p_owner text,
    p_success boolean,
    p_error text default null,
    p_error_class text default null,
    p_terminal boolean default false
)
returns service.roaster_postprocess_jobs
language plpgsql
security definer
set search_path = service, public, extensions, pg_catalog
as $function$
declare
    v_job service.roaster_postprocess_jobs;
    v_terminal_failure boolean;
begin
    if p_job_id is null then
        return null;
    end if;

    select j.* into v_job
    from service.roaster_postprocess_jobs j
    where j.id = p_job_id
    for update;

    if not found then
        return null;
    end if;

    -- Stale or stolen job: the caller no longer owns it (or it is no longer
    -- running, e.g. recovered or requeued). Return it unchanged, never clobber.
    if v_job.locked_by is distinct from p_owner
       or v_job.state <> 'running' then
        return v_job;
    end if;

    v_terminal_failure :=
        p_success is not true
        and (coalesce(p_terminal, false) or v_job.attempts >= v_job.max_attempts);

    update service.roaster_postprocess_jobs j
    set state = case
            when p_success is true then 'succeeded'
            when v_terminal_failure then 'failed'
            else 'retry_wait'
        end,
        run_after = case
            when v_terminal_failure then j.run_after
            when p_success is true then j.run_after
            else now()
                 + (interval '30 seconds' * power(2, least(j.attempts, 6))::int)
                 * (0.5 + random())
        end,
        finished_at = case
            when p_success is true or v_terminal_failure then now()
            else null
        end,
        locked_by = null,
        locked_at = null,
        last_error = case when p_success is true then null else p_error end,
        error_class = case when p_success is true then null else p_error_class end
    where j.id = v_job.id
    returning j.* into v_job;

    return v_job;
end;
$function$;

--------------------------------------------------------------------------------
-- 8) RPC 4: recover stale running jobs back to the runnable pool
--------------------------------------------------------------------------------

create or replace function service.recover_stale_roaster_jobs(
    p_stale_after interval default '10 minutes'
)
returns integer
language sql
security definer
set search_path = service, public, extensions, pg_catalog
as $function$
with recovered as (
    update service.roaster_postprocess_jobs
    set state = 'retry_wait',
        run_after = now(),
        locked_by = null,
        locked_at = null
    where state = 'running'
      and locked_at is not null
      and locked_at < now() - coalesce(p_stale_after, interval '10 minutes')
    returning 1
)
select count(*)::int from recovered;
$function$;

--------------------------------------------------------------------------------
-- 9) RPC 5: manual operator requeue (any state -> queued)
--------------------------------------------------------------------------------

create or replace function service.requeue_roaster_job(p_job_id bigint)
returns service.roaster_postprocess_jobs
language plpgsql
security definer
set search_path = service, public, extensions, pg_catalog
as $function$
declare
    v_job service.roaster_postprocess_jobs;
begin
    if p_job_id is null then
        return null;
    end if;

    update service.roaster_postprocess_jobs
    set state = 'queued',
        attempts = 0,
        run_after = now(),
        locked_by = null,
        locked_at = null,
        last_error = null,
        error_class = null,
        finished_at = null
    where id = p_job_id
    returning * into v_job;

    return v_job;
end;
$function$;

--------------------------------------------------------------------------------
-- 10) Function execute grants
--------------------------------------------------------------------------------
-- anon/authenticated must never reach these via PostgREST; the ledger schema
-- is internal machinery. postgres keeps EXECUTE because the SECURITY DEFINER
-- public trigger functions (attach_pending_global_beans,
-- enqueue_roaster_logo_mirror, ...) and the pg_cron dispatcher run as postgres.

revoke execute on function service.enqueue_roaster_job(bigint, text, text, timestamptz, boolean) from public;
revoke execute on function service.enqueue_roaster_job(bigint, text, text, timestamptz, boolean) from anon;
revoke execute on function service.enqueue_roaster_job(bigint, text, text, timestamptz, boolean) from authenticated;
grant execute on function service.enqueue_roaster_job(bigint, text, text, timestamptz, boolean) to service_role;
grant execute on function service.enqueue_roaster_job(bigint, text, text, timestamptz, boolean) to postgres;

revoke execute on function service.claim_roaster_jobs(text[], integer, text) from public;
revoke execute on function service.claim_roaster_jobs(text[], integer, text) from anon;
revoke execute on function service.claim_roaster_jobs(text[], integer, text) from authenticated;
grant execute on function service.claim_roaster_jobs(text[], integer, text) to service_role;
grant execute on function service.claim_roaster_jobs(text[], integer, text) to postgres;

revoke execute on function service.finish_roaster_job(bigint, text, boolean, text, text, boolean) from public;
revoke execute on function service.finish_roaster_job(bigint, text, boolean, text, text, boolean) from anon;
revoke execute on function service.finish_roaster_job(bigint, text, boolean, text, text, boolean) from authenticated;
grant execute on function service.finish_roaster_job(bigint, text, boolean, text, text, boolean) to service_role;
grant execute on function service.finish_roaster_job(bigint, text, boolean, text, text, boolean) to postgres;

revoke execute on function service.recover_stale_roaster_jobs(interval) from public;
revoke execute on function service.recover_stale_roaster_jobs(interval) from anon;
revoke execute on function service.recover_stale_roaster_jobs(interval) from authenticated;
grant execute on function service.recover_stale_roaster_jobs(interval) to service_role;
grant execute on function service.recover_stale_roaster_jobs(interval) to postgres;

revoke execute on function service.requeue_roaster_job(bigint) from public;
revoke execute on function service.requeue_roaster_job(bigint) from anon;
revoke execute on function service.requeue_roaster_job(bigint) from authenticated;
grant execute on function service.requeue_roaster_job(bigint) to service_role;
grant execute on function service.requeue_roaster_job(bigint) to postgres;
