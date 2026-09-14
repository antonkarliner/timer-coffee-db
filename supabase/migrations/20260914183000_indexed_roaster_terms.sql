-- Index-backed roaster term lookup: the last table-wide scan on the roaster
-- write path.
--
-- Plan 029 (20260914120100) and its follow-up (20260914160000) removed the
-- per-candidate resolver calls from the bean and bean-review linking triggers.
-- What survived in both was the `owners` CTE those rewrites introduced: the
-- ambiguity guard still had to find out which roasters/profiles claim a term,
-- and the only way to ask that question was to scan the whole table and
-- re-split every alias list with regexp_split_to_table.
--
-- Measured on production 2026-09-14, after 20260914160000:
--
--   coffee_roasters single insert    61 ms   (target < 100 ms, met)
--   coffee_roasters 50-row batch  2,082 ms   (target < 2,000 ms, ~4% over)
--
--   EXPLAIN (ANALYZE) of the owners CTE inside link_pending_bean_reviews:
--     Seq Scan on roaster_profiles (rows=1847)  18.4 ms  -- name half
--     Seq Scan on roaster_profiles (rows=1847)  24.5 ms  -- alias half
--   43 ms per insert x 50 = the entire 2,082 ms batch.
--
-- The same two scans sit on two further write paths that plan 029 did not
-- touch, because they call the per-row resolvers rather than the CTE:
--
--   trg_link_bean_review_to_roaster_profile  -> resolve_roaster_profile_for_review
--   trg_link_global_bean_to_coffee_roaster   -> resolve_coffee_roaster_id
--
-- One resolver call measured 21.3 ms / 2,464 buffers on production, so every
-- user review insert and every global-bean insert pays a full table scan too.
--
-- FIX
-- ---
-- Aliases are stored as one comma-separated text column and split at query
-- time, which cannot be indexed. This migration materializes the split as an
-- IMMUTABLE STORED generated `norm_terms text[]` column on both tables -- the
-- same house pattern plan 029 used for global_coffee_beans.normalized_roaster
-- and bean_reviews.normalized_roaster_name -- and indexes it with GIN. Every
-- "who claims this term?" question becomes `norm_terms && <terms>`.
--
-- A separate roaster_profile_terms(profile_id, term) table was the obvious
-- alternative and was rejected, because a side table has to be filled by a
-- trigger and there is no trigger timing that keeps the ambiguity guard exact:
--
--   * AFTER INSERT (the only timing an FK to roaster_profiles allows) runs
--     per row at statement end, interleaved with trg_link_pending_bean_reviews.
--     For a multi-row INSERT of two profiles whose normalized terms collide,
--     the first profile's link trigger would not yet see the second profile's
--     terms, so it would treat an ambiguous term as unique and link reviews to
--     it -- precisely the silent mis-link this guard exists to prevent. The
--     scanning version gets this right because both rows are already visible
--     in roaster_profiles.
--   * BEFORE INSERT fixes the ordering but cannot carry an FK, and rows it
--     writes survive the `on conflict do nothing` in
--     create_roaster_profile_on_insert, leaving phantom term owners that
--     silently disable linking for that term.
--
-- A STORED generated column has neither problem: it is computed when the row
-- itself is written, so it is exactly as visible as the row, and the guard
-- keeps reading the same table with the same snapshot it reads today. The
-- rewrite below is therefore a pure index change, not a semantics change.

--------------------------------------------------------------------------------
-- 1) One definition of the term set
--------------------------------------------------------------------------------
-- Extracted verbatim from the `my_terms` CTE that 20260914120100 and
-- 20260914160000 repeat: trim -> immutable_unaccent -> lower, empty mapped to
-- NULL and dropped, aliases split on '\s*,\s*'. The ordering matters (unaccent
-- before lower) for characters like Turkish I/i where the two orders differ.
--
-- regexp_split_to_array, not regexp_split_to_table: a generated column may not
-- contain a set-returning function, and the array form applies the identical
-- pattern.
--
-- IMMUTABLE is legal here only because public.immutable_unaccent is; plain
-- extensions.unaccent is STABLE and would not be.
--
-- NOTE: both norm_terms columns below are generated from this function, so its
-- return type is pinned, and replacing its body does NOT recompute already
-- stored values. Any future change to normalization must ship with an
-- explicit rewrite of both columns.
create or replace function public.roaster_norm_terms(
    p_roaster_name text,
    p_aliases text
)
returns text[]
language sql
immutable
parallel safe
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
    select coalesce(
        array(
            select distinct t.term
            from (
                select nullif(lower(public.immutable_unaccent(trim(p_roaster_name))), '') as term
                union all
                select nullif(lower(public.immutable_unaccent(trim(a.alias))), '') as term
                from unnest(
                    regexp_split_to_array(coalesce(p_aliases, ''), '\s*,\s*')
                ) as a(alias)
            ) t
            where t.term is not null
            order by t.term
        ),
        array[]::text[]
    );
$function$;

comment on function public.roaster_norm_terms(text, text) is
  'Normalized lookup terms for a roaster: its name plus each comma-separated alias, trim -> immutable_unaccent -> lower, empties dropped, sorted and deduplicated. Pinned by the generated norm_terms columns on coffee_roasters and roaster_profiles.';

grant execute on function public.roaster_norm_terms(text, text) to anon;
grant execute on function public.roaster_norm_terms(text, text) to authenticated;
grant execute on function public.roaster_norm_terms(text, text) to service_role;

--------------------------------------------------------------------------------
-- 2) Materialized terms on both tables + the indexes that kill the scans
--------------------------------------------------------------------------------
-- STORED, so the ALTER rewrites the table once (1,847 rows on production) and
-- every later insert/update recomputes only its own row.

alter table public.coffee_roasters
    add column if not exists norm_terms text[]
    generated always as (public.roaster_norm_terms(roaster_name, aliases)) stored;

comment on column public.coffee_roasters.norm_terms is
  'Generated: roaster_norm_terms(roaster_name, aliases) -- the indexed term set for roaster resolution and bean attachment.';

create index if not exists idx_coffee_roasters_norm_terms
    on public.coffee_roasters using gin (norm_terms);

alter table public.roaster_profiles
    add column if not exists norm_terms text[]
    generated always as (public.roaster_norm_terms(roaster_name, aliases)) stored;

comment on column public.roaster_profiles.norm_terms is
  'Generated: roaster_norm_terms(roaster_name, aliases) -- the indexed term set for review linking.';

-- Partial: every consumer of profile terms filters is_active = true.
create index if not exists idx_roaster_profiles_active_norm_terms
    on public.roaster_profiles using gin (norm_terms)
    where is_active;

-- Exact-name btree, mirroring idx_coffee_roasters_norm_name_exact
-- (20260914120100) on the profile side. The rewrites below no longer need it;
-- it stands for any remaining or future exact-name lookup on profiles, which
-- would otherwise be the one shape that still falls back to a scan.
create index if not exists idx_roaster_profiles_active_norm_name_exact
    on public.roaster_profiles (lower(public.immutable_unaccent(trim(roaster_name))))
    where is_active;

--------------------------------------------------------------------------------
-- 3) Per-row resolvers: scan -> GIN lookup
--------------------------------------------------------------------------------
-- Ambiguity guard unchanged: exactly one claimant, else NULL. `needle` exists
-- so a NULL normalized name can never reach the array overlap operator.

create or replace function public.resolve_coffee_roaster_id(p_roaster_name text)
returns bigint
language sql
stable
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  with input as (
    select nullif(lower(public.immutable_unaccent(trim(p_roaster_name))), '') as normalized_name
  ),
  needle as (
    select array[i.normalized_name] as terms
    from input i
    where i.normalized_name is not null
  ),
  roaster_matches as (
    select distinct cr.id
    from needle n
    join public.coffee_roasters cr on cr.norm_terms && n.terms
  )
  select case
    when count(*) = 1 then (array_agg(id))[1]
    else null::bigint
  end
  from roaster_matches;
$function$;

create or replace function public.resolve_roaster_profile_for_review(p_roaster_name text)
returns uuid
language sql
stable
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  with input as (
    select nullif(lower(public.immutable_unaccent(trim(p_roaster_name))), '') as normalized_name
  ),
  needle as (
    select array[i.normalized_name] as terms
    from input i
    where i.normalized_name is not null
  ),
  profile_matches as (
    select distinct rp.id
    from needle n
    join public.roaster_profiles rp
      on rp.is_active = true
     and rp.norm_terms && n.terms
  )
  select case
    when count(*) = 1 then (array_agg(id))[1]
    else null::uuid
  end
  from profile_matches;
$function$;

--------------------------------------------------------------------------------
-- 4) link_pending_bean_reviews: the owners CTE, indexed
--------------------------------------------------------------------------------
-- Guard preserved exactly. `owners` still yields one (profile, term) pair per
-- claim, restricted to MY terms -- the restriction matters: without
-- `t.term = any(m.terms)` the unnest would also emit other profiles' unrelated
-- unique terms, and good_terms would then relink their reviews to new.id.
-- `count(distinct o.id) = 1` then keeps only terms no other active profile
-- claims, new.id itself included in the count exactly as before.

create or replace function public.link_pending_bean_reviews()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
begin
    if new.is_active is not true then
        return new;
    end if;

    with my_terms as (
        select public.roaster_norm_terms(new.roaster_name, new.aliases) as terms
    ),
    owners as (
        select rp.id, t.term
        from my_terms m
        join public.roaster_profiles rp
          on rp.is_active = true
         and rp.norm_terms && m.terms
        cross join lateral unnest(rp.norm_terms) as t(term)
        where t.term = any(m.terms)
    ),
    good_terms as (
        select o.term
        from owners o
        group by o.term
        having count(distinct o.id) = 1
    )
    update public.bean_reviews br
    set roaster_profile_id = new.id
    from good_terms gt
    where br.roaster_profile_id is null
      and br.normalized_roaster_name = gt.term;

    return new;
end;
$function$;

--------------------------------------------------------------------------------
-- 5) attach_pending_global_beans_for_roaster: the owners CTE, indexed
--------------------------------------------------------------------------------
-- Same rewrite on the roaster side. Still returns the number of beans
-- attached, still idempotent (coffee_roaster_id is null excludes attached
-- beans), still safe under concurrent roaster inserts: term ownership and the
-- UPDATE share one snapshot in a single statement, and a term owned by 2+
-- roasters attaches nothing.

create or replace function public.attach_pending_global_beans_for_roaster(
    p_roaster_id bigint
)
returns integer
language sql
security definer
set search_path = public, extensions, pg_catalog
as $function$
with my_terms as (
    select cr.norm_terms as terms
    from public.coffee_roasters cr
    where cr.id = p_roaster_id
),
owners as (
    -- Every roaster that claims one of MY terms, via its name or an alias.
    select cr.id, t.term
    from my_terms m
    join public.coffee_roasters cr on cr.norm_terms && m.terms
    cross join lateral unnest(cr.norm_terms) as t(term)
    where t.term = any(m.terms)
),
good_terms as (
    -- The ambiguity guard: only terms claimed by EXACTLY ONE roaster (which
    -- must be p_roaster_id, since the term came from its own name/aliases).
    select o.term
    from owners o
    group by o.term
    having count(distinct o.id) = 1
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
-- 6) Statistics for the new columns
--------------------------------------------------------------------------------

analyze public.coffee_roasters;
analyze public.roaster_profiles;
