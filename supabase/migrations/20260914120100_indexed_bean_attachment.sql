-- Index-backed bean attachment.
--
-- Today the attach_pending_global_beans trigger re-evaluates
-- resolve_coffee_roaster_id per candidate bean row over an unindexed
-- lower(unaccent(trim(roaster))) filter: 435 ms / 10,637 buffers for ONE
-- roaster with 39 matching beans, which is what times a 50-roaster
-- transaction out with HTTP 504.
--
-- This migration:
--   1. adds public.global_coffee_beans.normalized_roaster, a STORED generated
--      column maintained by public.immutable_unaccent (IMMUTABLE, so legal in
--      a generated column and in indexes);
--   2. adds a partial index on it WHERE coffee_roaster_id is null -- the
--      index that kills the 435 ms scan;
--   3. adds a roaster-side expression index for exact normalized-term lookup;
--   4. adds public.attach_pending_global_beans_for_roaster(p_roaster_id),
--      which builds the roaster's normalized terms ONCE, drops any term
--      claimed by more than one roaster (the ambiguity guard), and attaches
--      unattached beans by a single indexed UPDATE -- O(matches), idempotent;
--   5. rewrites the attach_pending_global_beans trigger function to be
--      ENQUEUE-ONLY: it now only inserts a durable 'attach_beans' job into
--      service.roaster_postprocess_jobs (see 20260914120000) and does no
--      scanning and no network work. The trigger
--      trg_attach_pending_global_beans stays attached as-is.
--
-- The normalization expression is used VERBATIM everywhere below (bean-side
-- generated column, roaster-side terms, index): trim -> immutable_unaccent ->
-- lower, matching the legacy resolver's ordering (unaccent before lower, which
-- matters for characters like Turkish I/ı-dot where the two orders differ).

--------------------------------------------------------------------------------
-- 1) Bean-side generated column + the partial index that kills the scan
--------------------------------------------------------------------------------

alter table public.global_coffee_beans
    add column if not exists normalized_roaster text
    generated always as (
        nullif(lower(public.immutable_unaccent(trim(roaster))), '')
    ) stored;

comment on column public.global_coffee_beans.normalized_roaster is
  'Generated: nullif(lower(immutable_unaccent(trim(roaster))), '''') -- the exact-match key for roaster attachment.';

create index if not exists idx_global_coffee_beans_pending_norm_roaster
    on public.global_coffee_beans (normalized_roaster)
    where coffee_roaster_id is null;

--------------------------------------------------------------------------------
-- 2) Roaster-side term lookup index (exact normalized name)
--------------------------------------------------------------------------------

create index if not exists idx_coffee_roasters_norm_name_exact
    on public.coffee_roasters (lower(public.immutable_unaccent(trim(roaster_name))));

--------------------------------------------------------------------------------
-- 3) Per-roaster attachment: ambiguity-guarded, single indexed UPDATE
--------------------------------------------------------------------------------

-- Returns the number of beans attached. Safe to run twice (already-attached
-- beans are excluded by coffee_roaster_id is null) and safe under concurrent
-- roaster inserts (term ownership and the UPDATE share one snapshot in a
-- single statement; a term owned by 2+ roasters attaches nothing).
create or replace function public.attach_pending_global_beans_for_roaster(
    p_roaster_id bigint
)
returns integer
language sql
security definer
set search_path = public, extensions, pg_catalog
as $function$
with my_roaster as (
    select cr.id, cr.roaster_name, cr.aliases
    from public.coffee_roasters cr
    where cr.id = p_roaster_id
),
my_terms as (
    select distinct nullif(lower(public.immutable_unaccent(trim(m.roaster_name))), '') as term
    from my_roaster m
    union
    select distinct nullif(lower(public.immutable_unaccent(trim(a.alias))), '') as term
    from my_roaster m
    cross join lateral regexp_split_to_table(coalesce(m.aliases, ''), '\s*,\s*') as a(alias)
),
non_empty_terms as (
    select t.term
    from my_terms t
    where t.term is not null
),
owners as (
    -- Every roaster that claims one of MY terms via its name...
    select cr.id, lower(public.immutable_unaccent(trim(cr.roaster_name))) as term
    from public.coffee_roasters cr
    where exists (
        select 1
        from non_empty_terms t
        where t.term = lower(public.immutable_unaccent(trim(cr.roaster_name)))
    )
    union all
    -- ...or via one of its comma-split aliases.
    select cr.id, lower(public.immutable_unaccent(trim(a.alias))) as term
    from public.coffee_roasters cr
    cross join lateral regexp_split_to_table(coalesce(cr.aliases, ''), '\s*,\s*') as a(alias)
    where exists (
        select 1
        from non_empty_terms t
        where t.term = lower(public.immutable_unaccent(trim(a.alias)))
    )
),
owner_counts as (
    select o.term, count(distinct o.id) as owner_count
    from owners o
    group by o.term
),
good_terms as (
    -- The ambiguity guard: only terms claimed by EXACTLY ONE roaster (which
    -- must be p_roaster_id, since the term came from its own name/aliases).
    select o.term
    from owner_counts o
    where o.owner_count = 1
),
attached as (
    update public.global_coffee_beans g
    set coffee_roaster_id = p_roaster_id
    from good_terms gt
    where g.coffee_roaster_id is null
      and g.normalized_roaster = gt.term
    returning 1
)
select count(*)::int
from attached;
$function$;

revoke execute on function public.attach_pending_global_beans_for_roaster(bigint) from public;
revoke execute on function public.attach_pending_global_beans_for_roaster(bigint) from anon;
revoke execute on function public.attach_pending_global_beans_for_roaster(bigint) from authenticated;
grant execute on function public.attach_pending_global_beans_for_roaster(bigint) to service_role;
grant execute on function public.attach_pending_global_beans_for_roaster(bigint) to postgres;

--------------------------------------------------------------------------------
-- 4) Rewrite the roaster trigger to ENQUEUE-ONLY
--------------------------------------------------------------------------------
-- No scanning, no network: the heavy work moves to the durable ledger and is
-- executed by the roaster-postprocess-worker. The trigger
-- trg_attach_pending_global_beans (20260628200000) stays attached unchanged.

create or replace function public.attach_pending_global_beans()
returns trigger
language plpgsql
security definer
set search_path = public, service, extensions, pg_catalog
as $function$
begin
    perform service.enqueue_roaster_job(
        new.id,
        'attach_beans',
        coalesce(new.normalized_name, '') || '|' || coalesce(new.normalized_aliases, '')
    );
    return new;
end;
$function$;
