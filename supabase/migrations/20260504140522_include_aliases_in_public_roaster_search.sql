-- Include roaster aliases in the public /roasters catalog search document.
-- This keeps the existing unaccented, case-insensitive search behavior and
-- rebuilds the trigram expression index against the expanded document.

drop index if exists public.roaster_profiles_catalog_search_trgm_idx;

create or replace function public.roaster_catalog_search_document(
  p_roaster_name text,
  p_aliases text,
  p_city text,
  p_state text,
  p_country text
)
returns text
language sql
immutable
set search_path = public
as $function$
  select public.immutable_unaccent(
    lower(
      coalesce(p_roaster_name, '')
      || ' ' || coalesce(p_aliases, '')
      || ' ' || coalesce(p_city, '')
      || ' ' || coalesce(p_state, '')
      || ' ' || coalesce(p_country, '')
    )
  );
$function$;

create index if not exists roaster_profiles_catalog_search_trgm_idx
on public.roaster_profiles
using gin (
  public.roaster_catalog_search_document(
    roaster_name,
    aliases,
    city,
    state,
    country
  ) extensions.gin_trgm_ops
)
where is_active = true;

create or replace function public.list_roaster_profiles(
  p_search text default null,
  p_country text default null,
  p_offset int default 0,
  p_limit int default 30
)
returns table (
  id uuid,
  slug text,
  roaster_name text,
  city text,
  state text,
  country text,
  roaster_logo_url text,
  roaster_logo_mirror_url text,
  dominant_color_hex text,
  admin_user_id text,
  is_active boolean
)
language sql
stable
security definer
set search_path = public
as $function$
  with filters as (
    select
      nullif(public.immutable_unaccent(lower(trim(p_search))), '') as normalized_search,
      nullif(trim(p_country), '') as normalized_country
  )
  select
    rp.id,
    rp.slug,
    rp.roaster_name,
    rp.city,
    rp.state,
    rp.country,
    rp.roaster_logo_url,
    rp.roaster_logo_mirror_url,
    rp.dominant_color_hex,
    rp.admin_user_id::text,
    rp.is_active
  from public.roaster_profiles rp
  cross join filters
  where rp.is_active = true
    and (
      filters.normalized_country is null
      or rp.country = filters.normalized_country
    )
    and (
      filters.normalized_search is null
      or public.roaster_catalog_search_document(
        rp.roaster_name,
        rp.aliases,
        rp.city,
        rp.state,
        rp.country
      ) ilike '%' || filters.normalized_search || '%'
    )
  order by public.immutable_unaccent(lower(rp.roaster_name)) asc
  offset p_offset
  limit p_limit;
$function$;
