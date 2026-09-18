-- Wire name-embedding generation into the durable roaster post-processing
-- pipeline (ledger + RPCs: 20260914120000; triggers: 20260914120200;
-- reconciliation + dispatcher: 20260914120300).
--
-- THE DEFECT: nothing ever invoked generate-roaster-embedding automatically.
-- There was no trigger, no job kind, no cron. A roaster inserted today never
-- got a public.coffee_roasters.name_embedding and was therefore silently
-- invisible to public.search_roasters_by_vector and
-- public.find_potential_roaster_matches_with_vector (both filter
-- WHERE name_embedding IS NOT NULL). Measured on production 2026-09-17:
-- 2,057 roasters, 55 with name_embedding IS NULL (ids 2487-2541, the newest
-- block -- every roaster added since the last manual backfill drain).
--
-- WHAT THIS ADDS:
--   1. The 'generate_embedding' job kind in the ledger's CHECK constraint.
--   2. trg_enqueue_roaster_embedding: INSERT/UPDATE of roaster_name/aliases
--      enqueues a job, modelled on enqueue_roaster_logo_mirror.
--   3. Reconciliation learns the 'missing_embedding' violation and can
--      enqueue the fix.
--   4. An hourly coverage cron that heals anything the triggers miss, and
--      logs its coverage numbers to service.cleanup_logs so the invariant is
--      observable without running anything by hand.
--   5. Retirement of the second, disagreeing ledger
--      (service.roaster_embedding_backfill) as a gate.
--   6. A one-time backfill for the 55 never-embedded roasters plus 23
--      roasters whose stored vector encodes pre-repair (corrupt) alias text.
--
-- source_revision CONTRACT for the new kind (must stay byte-identical to
-- currentSourceRevision in roaster-postprocess-worker/runner.ts):
--   generate_embedding -> coalesce(roaster_name,'') || '|' || coalesce(aliases,'')
-- This deliberately uses the RAW roaster_name/aliases columns, NOT the
-- normalized ones that attach_beans uses: the embedded text is built from the
-- raw columns by buildEmbeddingInput (_shared/roaster-embedding-core.ts). If
-- the two sides ever disagree, the worker discards every job as stale.

--------------------------------------------------------------------------------
-- 1) Extend the kind CHECK constraint
--------------------------------------------------------------------------------

-- The CHECK was created inline by `create table`, so PostgreSQL named it
-- automatically (conventionally roaster_postprocess_jobs_kind_check).
-- Resolve the real name from the catalog instead of assuming it, then drop
-- and re-create with the new kind. Guarded so a replay on a fresh database
-- (where 20260914120000 has just created the table with the original three
-- kinds) behaves identically to production.

do $$
declare
    v_table_oid        oid;
    v_constraint_name  text;
begin
    select c.oid into v_table_oid
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'service'
      and c.relname = 'roaster_postprocess_jobs';

    if v_table_oid is null then
        raise exception 'service.roaster_postprocess_jobs is missing; apply 20260914120000 first';
    end if;

    select con.conname into v_constraint_name
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = any (con.conkey)
    where con.conrelid = v_table_oid
      and con.contype = 'c'
      and att.attname = 'kind';

    if v_constraint_name is not null then
        execute format(
            'alter table service.roaster_postprocess_jobs drop constraint %I',
            v_constraint_name
        );
    end if;

    if not exists (
        select 1 from pg_constraint
        where conrelid = v_table_oid
          and conname = 'roaster_postprocess_jobs_kind_check'
          and contype = 'c'
    ) then
        alter table service.roaster_postprocess_jobs
            add constraint roaster_postprocess_jobs_kind_check
            check (kind in ('mirror_logo', 'extract_color', 'attach_beans', 'generate_embedding'));
    end if;
end;
$$;

comment on column service.roaster_postprocess_jobs.source_revision is
  'Identity of the input this job is for: mirror_logo -> roaster_logo_url; extract_color -> roaster_logo_mirror_url; attach_beans -> normalized_name || ''|'' || normalized_aliases; generate_embedding -> coalesce(roaster_name,'''') || ''|'' || coalesce(aliases,'''') (RAW columns -- the embedded text is built from them, not from the normalized_* columns).';

--------------------------------------------------------------------------------
-- 2) Enqueue trigger: roaster_name / aliases changes -> generate_embedding job
--------------------------------------------------------------------------------

-- Modelled on public.enqueue_roaster_logo_mirror (20260914120200).
--
-- Two subtleties this shape exists for:
--   * The trigger's WHEN clause must not reference `old` -- PostgreSQL
--     rejects that on a trigger that also fires on INSERT. That is why the
--     old-vs-new distinctness check lives in the function body, same as
--     enqueue_roaster_logo_mirror.
--   * `update of roaster_name, aliases` fires whenever a column is MENTIONED
--     in the SET list, even if the value is unchanged. The body's
--     `is not distinct from` check is what prevents pointless jobs (and the
--     enqueue RPC's active-row ON CONFLICT dedupes whatever slips through).

create or replace function public.enqueue_roaster_embedding()
returns trigger
language plpgsql
security definer
set search_path = public, service, extensions, pg_catalog
as $function$
begin
    -- Nothing to embed without a usable name (the WHEN clause already
    -- excludes NULL; this also catches blank strings).
    if new.roaster_name is null or btrim(new.roaster_name) = '' then
        return new;
    end if;

    if tg_op = 'UPDATE'
       and new.roaster_name is not distinct from old.roaster_name
       and new.aliases is not distinct from old.aliases then
        return new;
    end if;

    perform service.enqueue_roaster_job(
        new.id,
        'generate_embedding',
        coalesce(new.roaster_name, '') || '|' || coalesce(new.aliases, '')
    );

    return new;
end;
$function$;

-- Guarded drop (CLAUDE.md: DROP TRIGGER IF EXISTS errors when the TABLE is
-- missing).
do $$
begin
    if exists (
        select 1 from pg_tables
        where schemaname = 'public' and tablename = 'coffee_roasters'
    ) then
        drop trigger if exists trg_enqueue_roaster_embedding on public.coffee_roasters;
    end if;
end;
$$;

create trigger trg_enqueue_roaster_embedding
    after insert or update of roaster_name, aliases on public.coffee_roasters
    for each row
    when (new.roaster_name is not null)
    execute function public.enqueue_roaster_embedding();

-- NEW function: the project's ALTER DEFAULT PRIVILEGES grant EXECUTE to
-- anon/authenticated/service_role by name, so revoke from those roles
-- explicitly (revoke from PUBLIC alone never removed them).
revoke execute on function public.enqueue_roaster_embedding() from public;
revoke execute on function public.enqueue_roaster_embedding() from anon;
revoke execute on function public.enqueue_roaster_embedding() from authenticated;
grant execute on function public.enqueue_roaster_embedding() to service_role;
grant execute on function public.enqueue_roaster_embedding() to postgres;

comment on function public.enqueue_roaster_embedding() is
  'Trigger fn: enqueues a generate_embedding job when a roaster name/alias changes. SECURITY DEFINER; never callable by anon/authenticated.';

--------------------------------------------------------------------------------
-- 3) Reconciliation: teach it the missing_embedding violation
--------------------------------------------------------------------------------

-- Body reproduced unchanged from 20260914120300 with exactly two additions:
-- the p_enqueue perform and the 'missing_embedding' union row. create or
-- replace preserves the existing ACL; the grant block is re-asserted for
-- consistency with 20260914120300, which re-asserted it after its own
-- create or replace.

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

        -- missing_embedding -> generate_embedding. Revision is the RAW
        -- name|aliases text (the embedding input), not the normalized columns
        -- attach_beans uses. Unlike extract_color there is no
        -- "legitimately succeeded without a result" case: a succeeded
        -- generate_embedding job always stored a vector.
        perform service.enqueue_roaster_job(
            cr.id, 'generate_embedding',
            coalesce(cr.roaster_name,'') || '|' || coalesce(cr.aliases,''))
        from public.coffee_roasters cr
        where cr.name_embedding is null
          and coalesce(btrim(cr.roaster_name), '') <> '';

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

        -- Roasters with no name_embedding and a usable name. Same predicate
        -- as the generate_embedding enqueue above.
        select 'missing_embedding'::text, cr.id, 'name_embedding is null'::text
        from public.coffee_roasters cr
        where cr.name_embedding is null
          and coalesce(btrim(cr.roaster_name), '') <> ''

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
-- 4) Coverage cron: the thing that stops this regressing silently
--------------------------------------------------------------------------------

-- Hourly sweep that enqueues generate_embedding for every roaster still
-- missing a vector. It makes NO HTTP call: the per-minute
-- roaster-postprocess-dispatch job (20260914120300) already wakes the worker
-- whenever anything is runnable, so this only has to put rows in the queue.
--
-- The failed-at-current-revision guard is load-bearing: without it, a roaster
-- whose embedding can never be produced (e.g. embedding_input_empty or a
-- provider 4xx) is re-enqueued every hour and burns max_attempts retries each
-- time, forever. A terminal failure is an operator decision
-- (service.requeue_roaster_job), exactly as the reconciliation comments say
-- for terminal_job.

create or replace function public.roaster_embedding_coverage_cron()
returns void
language plpgsql
security definer
set search_path = public, service, extensions, pg_catalog
as $function$
declare
    v_null_count integer := 0;
    v_enqueued   integer := 0;
begin
    select count(*)::int into v_null_count
    from public.coffee_roasters
    where name_embedding is null;

    with enqueued as (
        select service.enqueue_roaster_job(
            cr.id, 'generate_embedding',
            coalesce(cr.roaster_name,'') || '|' || coalesce(cr.aliases,'')) as job_id
        from public.coffee_roasters cr
        where cr.name_embedding is null
          and coalesce(btrim(cr.roaster_name), '') <> ''
          and not exists (
              -- Skip roasters that already have a FAILED generate_embedding
              -- job at the current revision: retrying them needs an operator
              -- decision, not an hourly automatic re-enqueue.
              select 1 from service.roaster_postprocess_jobs j
              where j.roaster_id = cr.id
                and j.kind = 'generate_embedding'
                and j.state = 'failed'
                and j.source_revision = coalesce(cr.roaster_name,'') || '|' || coalesce(cr.aliases,'')
          )
    )
    select count(*)::int into v_enqueued
    from enqueued
    where job_id is not null;

    -- service.cleanup_logs is not created by any migration in this repo; wrap
    -- the insert so a from-scratch replay cannot die here (same pattern as
    -- the dispatcher in 20260914120300). The warning keeps the failure
    -- visible in the Postgres log.
    begin
        insert into service.cleanup_logs (action, records_affected, details)
        values (
            'roaster-embedding-coverage',
            v_null_count,
            jsonb_build_object(
                'null_embedding_count', v_null_count,
                'enqueued_count', v_enqueued,
                'executed_at', timezone('utc', now())
            )
        );
    exception when others then
        raise warning 'roaster-embedding-coverage: cleanup_logs write failed: %', sqlerrm;
    end;
end;
$function$;

revoke execute on function public.roaster_embedding_coverage_cron() from public;
revoke execute on function public.roaster_embedding_coverage_cron() from anon;
revoke execute on function public.roaster_embedding_coverage_cron() from authenticated;
grant execute on function public.roaster_embedding_coverage_cron() to service_role;
grant execute on function public.roaster_embedding_coverage_cron() to postgres;

comment on function public.roaster_embedding_coverage_cron() is
  'Hourly pg_cron coverage sweep: enqueues generate_embedding for roasters still missing name_embedding, skipping terminal failures at the current revision, and logs the coverage counts to service.cleanup_logs.';

-- Guarded unschedule/schedule keeps the migration replayable (shape copied
-- from section 3 of 20260914120300).
do $cron$
declare
    v_job_id integer;
begin
    select jobid into v_job_id
    from cron.job
    where jobname = 'roaster-embedding-coverage'
    order by jobid desc
    limit 1;

    if v_job_id is not null then
        perform cron.unschedule(v_job_id);
    end if;

    perform cron.schedule(
        'roaster-embedding-coverage',
        '0 * * * *',
        'select public.roaster_embedding_coverage_cron();'
    );
end;
$cron$
language plpgsql;

--------------------------------------------------------------------------------
-- 5) Retire the second ledger as a gate
--------------------------------------------------------------------------------

-- There were two places claiming to record embedding coverage and they
-- disagreed. service.roaster_embedding_backfill is a one-time table last
-- written 2026-01-27; its success=true rows filtered roasters out of
-- public.get_roasters_needing_embeddings, and a row claiming success for a
-- roaster with no vector made that roaster permanently invisible to the work
-- queue. That already happened twice, each needing its own repair migration
-- (20260917170000_requeue_merged_roaster_embeddings.sql,
-- 20260917190000_clear_false_success_embedding_ledger.sql).
-- service.roaster_postprocess_jobs (kind generate_embedding) is now the only
-- real ledger.
--
-- The table is NOT dropped: the data is evidence, and
-- public.record_embedding_backfill still has a live caller in
-- scripts/backfill-roaster-embeddings.ts.

-- Remove the backfill-table join so the queue is
-- `WHERE cr.name_embedding IS NULL` and nothing can hide a roaster from it
-- again. Signature, LANGUAGE sql STABLE, returned columns, ORDER BY cr.id and
-- LIMIT batch_size are unchanged.
--
-- The `set search_path` clause below is NOT optional and must not be dropped.
-- `create or replace function` preserves ONLY ownership and permissions: per
-- the PostgreSQL docs, "all other function properties are assigned the values
-- specified or implied in the command", and that includes proconfig. Verified
-- on the local stack 2026-09-17 -- ALTER FUNCTION ... SET search_path, then a
-- bare CREATE OR REPLACE, leaves proconfig NULL. Omitting it here would
-- silently undo 20260514120002_fix_function_search_paths.sql for this
-- function and re-open the mutable-search_path finding. The value below is
-- byte-identical to what that migration set and to what production carries
-- today, so this migration changes no setting and (ACL being preserved) no
-- grant.
create or replace function public.get_roasters_needing_embeddings(batch_size int default 10)
returns table(
  id bigint,
  roaster_name text,
  aliases text
)
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_catalog
AS $function$
  SELECT
    cr.id,
    cr.roaster_name,
    cr.aliases
  FROM public.coffee_roasters cr
  WHERE cr.name_embedding IS NULL
  ORDER BY cr.id
  LIMIT batch_size;
$function$;

comment on table service.roaster_embedding_backfill is
  'SUPERSEDED 2026-09-17 by service.roaster_postprocess_jobs (kind generate_embedding). Retained only as the historical record of the 2026-01-27 backfill run. Its success rows no longer gate any queue; do not write to it.';

comment on function public.record_embedding_backfill(bigint, boolean, text) is
  'SUPERSEDED 2026-09-17 by service.roaster_postprocess_jobs (kind generate_embedding). Retained only because scripts/backfill-roaster-embeddings.ts still calls it; recording success here no longer gates anything.';

--------------------------------------------------------------------------------
-- 6) One-time backfill
--------------------------------------------------------------------------------

-- 6a. Every roaster with no embedding at all (55 on production 2026-09-17,
--     ids 2487-2541) -- written as a predicate, not a hardcoded id list, so
--     it stays correct whenever this migration is applied.
select service.enqueue_roaster_job(
    cr.id, 'generate_embedding',
    coalesce(cr.roaster_name,'') || '|' || coalesce(cr.aliases,''))
from public.coffee_roasters cr
where cr.name_embedding is null
  and coalesce(btrim(cr.roaster_name), '') <> '';

-- 6b. 23 roasters carrying a STALE vector. 20260917180000 (plan 037) rewrote
--     their `aliases` to undo Postgres array-literal corruption (e.g. id 102
--     went from '{Wonderstate}' to 'Wonderstate') without nulling
--     name_embedding, and plan 037's implementation notes confirm no manual
--     re-embedding was performed. Every one carries an embedding_updated_at
--     predating that repair (three from 2026-01-27, twenty from the
--     2026-09-17 09:45 backfill drain, which ran before the repair), so the
--     stored vectors encode the corrupt alias text. name_embedding is
--     deliberately left alone here: the worker overwrites it, and nulling it
--     first would drop these roasters out of vector search for the ~10
--     minutes the queue takes to drain. No p_force is needed:
--     generate_embedding is a brand-new kind, so no 'succeeded' row can
--     exist for them yet.
select service.enqueue_roaster_job(
    cr.id, 'generate_embedding',
    coalesce(cr.roaster_name,'') || '|' || coalesce(cr.aliases,''))
from public.coffee_roasters cr
where cr.id in (
    102, 228, 541, 1170, 1171, 1173, 1181, 1182, 1188, 1189, 1192, 1194, 1195,
    1200, 1201, 1203, 1205, 1206, 1207, 1209, 1211, 1214, 1215
);
