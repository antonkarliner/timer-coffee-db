-- Move logo mirroring + colour extraction off the coffee_roasters write
-- transaction and onto the durable job ledger (20260914120000).
--
-- Before: supabase_functions.http_request triggers fired the roaster-logo-mirror
-- edge function inline on INSERT/UPDATE, and
-- enqueue_roaster_dominant_color_generation() read Vault and issued
-- net.http_post inline on mirror-URL updates. After: all three write paths
-- (logo, colour, beans) only enqueue durable jobs; the
-- roaster-postprocess-worker Edge Function does the actual work.
--
-- A backfill at the end enqueues jobs for every existing invariant violation
-- so the new pipeline heals the current backlog (production today:
-- 0 source-without-mirror, 1 mirror-without-colour, and 3,461 unattached
-- beans, most of which are legitimately ambiguous or roaster-less -- only
-- roasters with exact UNAMBIGUOUS unattached matches get an attach job).

--------------------------------------------------------------------------------
-- 1) Logo mirroring -> mirror_logo job
--------------------------------------------------------------------------------

create or replace function public.enqueue_roaster_logo_mirror()
returns trigger
language plpgsql
security definer
set search_path = public, service, extensions, pg_catalog
as $function$
begin
    if new.roaster_logo_url is null then
        return new;
    end if;

    if tg_op = 'UPDATE'
       and new.roaster_logo_url is not distinct from old.roaster_logo_url then
        return new;
    end if;

    perform service.enqueue_roaster_job(
        new.id,
        'mirror_logo',
        new.roaster_logo_url
    );

    return new;
end;
$function$;

drop trigger if exists trg_enqueue_roaster_logo_mirror on public.coffee_roasters;

create trigger trg_enqueue_roaster_logo_mirror
    after insert or update of roaster_logo_url on public.coffee_roasters
    for each row
    when (new.roaster_logo_url is not null)
    execute function public.enqueue_roaster_logo_mirror();

--------------------------------------------------------------------------------
-- 2) Colour extraction -> extract_color job (body becomes enqueue-only)
--------------------------------------------------------------------------------
-- Same function name/shape as before (20260407000000), but no Vault read and
-- no net.http_post. The mirror worker updating roaster_logo_mirror_url is
-- what triggers this, chaining mirror_logo -> extract_color naturally.

create or replace function public.enqueue_roaster_dominant_color_generation()
returns trigger
language plpgsql
security definer
set search_path = public, service, extensions, pg_catalog
as $function$
begin
    if new.roaster_logo_mirror_url is null then
        return new;
    end if;

    perform service.enqueue_roaster_job(
        new.id,
        'extract_color',
        new.roaster_logo_mirror_url
    );

    return new;
end;
$function$;

-- Keep the trigger attached as-is; re-assert its definition so a replay of
-- the chain always lands in the known state.
drop trigger if exists trg_generate_roaster_dominant_color on public.coffee_roasters;

create trigger trg_generate_roaster_dominant_color
    after update of roaster_logo_mirror_url on public.coffee_roasters
    for each row
    when (old.roaster_logo_mirror_url is distinct from new.roaster_logo_mirror_url)
    execute function public.enqueue_roaster_dominant_color_generation();

--------------------------------------------------------------------------------
-- 3) Retire the inline supabase_functions.http_request logo triggers
--------------------------------------------------------------------------------
-- Drops are guarded (CLAUDE.md: DROP TRIGGER IF EXISTS errors when the TABLE
-- is missing; this also skips the drop if the trigger is already gone).

do $$
begin
    if exists (
        select 1 from pg_tables
        where schemaname = 'public' and tablename = 'coffee_roasters'
    ) and exists (
        select 1 from pg_trigger
        where tgrelid = 'public.coffee_roasters'::regclass
          and tgname = 'process_new_coffee_roaster_logo'
          and not tgisinternal
    ) then
        execute 'drop trigger process_new_coffee_roaster_logo on public.coffee_roasters';
    end if;

    if exists (
        select 1 from pg_tables
        where schemaname = 'public' and tablename = 'coffee_roasters'
    ) and exists (
        select 1 from pg_trigger
        where tgrelid = 'public.coffee_roasters'::regclass
          and tgname = 'process_updated_coffee_roaster_logo'
          and not tgisinternal
    ) then
        execute 'drop trigger process_updated_coffee_roaster_logo on public.coffee_roasters';
    end if;
end;
$$;

--------------------------------------------------------------------------------
-- 4) Backfill: enqueue jobs for every existing invariant violation
--------------------------------------------------------------------------------

-- 4a. source-without-mirror -> mirror_logo
select service.enqueue_roaster_job(cr.id, 'mirror_logo', cr.roaster_logo_url)
from public.coffee_roasters cr
where cr.roaster_logo_url is not null
  and cr.roaster_logo_mirror_url is null;

-- 4b. mirror-without-colour -> extract_color
select service.enqueue_roaster_job(cr.id, 'extract_color', cr.roaster_logo_mirror_url)
from public.coffee_roasters cr
where cr.roaster_logo_mirror_url is not null
  and cr.dominant_color_hex is null;

-- 4c. roasters whose exact UNAMBIGUOUS bean matches are still unattached
--     -> attach_beans (one job per roaster; the worker does the attachment).
--     Ambiguous or roaster-less beans are intentionally left alone.
with owners as (
    select cr.id, nullif(lower(public.immutable_unaccent(trim(cr.roaster_name))), '') as term
    from public.coffee_roasters cr
    union all
    select cr.id, nullif(lower(public.immutable_unaccent(trim(a.alias))), '') as term
    from public.coffee_roasters cr
    cross join lateral regexp_split_to_table(coalesce(cr.aliases, ''), '\s*,\s*') as a(alias)
),
unambiguous_owner as (
    select o.term, min(o.id) as roaster_id
    from owners o
    where o.term is not null
    group by o.term
    having count(distinct o.id) = 1
),
needy_roasters as (
    select distinct u.roaster_id, cr.normalized_name, cr.normalized_aliases
    from unambiguous_owner u
    join public.global_coffee_beans g
      on g.coffee_roaster_id is null
     and g.normalized_roaster = u.term
    join public.coffee_roasters cr
      on cr.id = u.roaster_id
)
select service.enqueue_roaster_job(
    n.roaster_id,
    'attach_beans',
    coalesce(n.normalized_name, '') || '|' || coalesce(n.normalized_aliases, '')
)
from needy_roasters n;
