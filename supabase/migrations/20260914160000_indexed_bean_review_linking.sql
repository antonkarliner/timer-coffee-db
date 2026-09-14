-- Index-backed pending bean-review linking.
--
-- Plan 029 removed the table-wide scan from `attach_pending_global_beans` on
-- public.coffee_roasters, but its structural twin on the profile side survived
-- and then dominated the write path.
--
-- `trg_create_roaster_profile` inserts a row into public.roaster_profiles for
-- every new roaster, which fires `trg_link_pending_bean_reviews`. That trigger
-- selects `public.resolve_roaster_profile_for_review(br.roaster_name)` in the
-- target list of a CTE over every unlinked review, so the resolver is evaluated
-- for all of them regardless of whether they match the new profile. Each call
-- rescans roaster_profiles and re-splits every alias list.
--
-- Measured against production 2026-09-14, immediately after plan 029 stage 3:
--
--   roaster_profiles insert, triggers OFF      1.38 ms
--   roaster_profiles insert, triggers ON     543.78 ms
--   trigger's own UPDATE run standalone        0.51 ms
--   resolve() across all 43 unlinked reviews  533.65 ms   <-- the whole cost
--
--   coffee_roasters: single insert  611 ms, 50-row batch 27,983 ms
--
-- That misses plan 029's acceptance targets (<100 ms single, <2 s for 50) and
-- violates its invariant 4 ("no trigger performs a table-wide scan inside the
-- user transaction"). This migration applies the same fix that worked for
-- beans in 20260914120100:
--
--   1. a maintained normalized column on bean_reviews + a partial index for
--      the unlinked rows;
--   2. a rewritten trigger that builds the profile's terms ONCE, drops any
--      term claimed by more than one ACTIVE profile (the ambiguity guard that
--      replaces the per-row resolver), and issues a single indexed UPDATE.
--
-- `resolve_roaster_profile_for_review` is left in place: it is still the right
-- tool for the per-review path (trg_link_bean_review_to_roaster_profile), where
-- it is called once per row rather than once per candidate.

--------------------------------------------------------------------------------
-- 1) Normalized column + partial index
--------------------------------------------------------------------------------

alter table public.bean_reviews
    add column if not exists normalized_roaster_name text
    generated always as (
        nullif(lower(public.immutable_unaccent(trim(roaster_name))), '')
    ) stored;

comment on column public.bean_reviews.normalized_roaster_name is
  'Generated: nullif(lower(immutable_unaccent(trim(roaster_name))), '''') -- exact-match key for roaster-profile linking.';

create index if not exists idx_bean_reviews_pending_norm_roaster
    on public.bean_reviews (normalized_roaster_name)
    where roaster_profile_id is null;

--------------------------------------------------------------------------------
-- 2) Enqueue-free, index-backed trigger
--------------------------------------------------------------------------------
-- Ambiguity rule preserved from resolve_roaster_profile_for_review: a term is
-- only usable when exactly ONE active profile claims it, via its own name or a
-- comma-split alias. Inactive profiles are ignored, as before.

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
        select nullif(lower(public.immutable_unaccent(trim(new.roaster_name))), '') as term
        union
        select nullif(lower(public.immutable_unaccent(trim(a.alias))), '') as term
        from regexp_split_to_table(coalesce(new.aliases, ''), '\s*,\s*') as a(alias)
    ),
    non_empty_terms as (
        select t.term from my_terms t where t.term is not null
    ),
    owners as (
        select rp.id, lower(public.immutable_unaccent(trim(rp.roaster_name))) as term
        from public.roaster_profiles rp
        where rp.is_active = true
          and exists (
              select 1 from non_empty_terms t
              where t.term = lower(public.immutable_unaccent(trim(rp.roaster_name)))
          )
        union all
        select rp.id, lower(public.immutable_unaccent(trim(a.alias))) as term
        from public.roaster_profiles rp
        cross join lateral regexp_split_to_table(coalesce(rp.aliases, ''), '\s*,\s*') as a(alias)
        where rp.is_active = true
          and exists (
              select 1 from non_empty_terms t
              where t.term = lower(public.immutable_unaccent(trim(a.alias)))
          )
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
