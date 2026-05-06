-- Optimize public roaster browsing queries:
-- - make catalog search indexable with trigram + immutable_unaccent
-- - speed up public recipe localization lookup
-- - speed up public review pagination
-- - add a slug-based reviews RPC for cheap "load more reviews" requests

create index if not exists user_recipe_localizations_recipe_id_locale_idx
on public.user_recipe_localizations using btree (recipe_id, locale);

create index if not exists user_recipes_public_vendor_last_modified_idx
on public.user_recipes using btree (vendor_id, last_modified desc)
where ispublic = true
  and coalesce(is_deleted, false) = false;

create index if not exists bean_reviews_public_roaster_created_at_idx
on public.bean_reviews using btree (roaster_profile_id, created_at desc)
where is_public = true;

create or replace function public.roaster_catalog_search_document(
  p_roaster_name text,
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
    city,
    state,
    country
  ) extensions.gin_trgm_ops
)
where is_active = true;

create or replace function public.get_roaster_recipes(
  p_admin_user_id uuid,
  p_locale text default 'en'
)
returns json
language sql
stable
security definer
set search_path = public
as $function$
  select coalesce(json_agg(t), '[]'::json)
  from (
    select
      ur.id,
      ur.brewing_method_id,
      bm.brewing_method as brewing_method_name,
      ur.coffee_amount,
      ur.water_amount,
      ur.water_temp,
      ur.brew_time,
      ur.ispublic as is_public,
      localization.name,
      localization.grind_size,
      localization.short_description
    from public.user_recipes ur
    left join public.brewing_methods bm
           on bm.brewing_method_id = ur.brewing_method_id
    left join lateral (
      select
        url.name,
        url.grind_size,
        url.short_description
      from public.user_recipe_localizations url
      where url.recipe_id = ur.id
        and url.locale in (coalesce(nullif(p_locale, ''), 'en'), 'en')
      order by case
        when url.locale = coalesce(nullif(p_locale, ''), 'en') then 0
        else 1
      end
      limit 1
    ) localization on true
    where ur.vendor_id = 'usr-' || p_admin_user_id::text
      and ur.ispublic = true
      and coalesce(ur.is_deleted, false) = false
    order by ur.last_modified desc
  ) t;
$function$;

create or replace function public.get_roaster_reviews_by_slug(
  p_slug text,
  p_offset integer default 0,
  p_limit integer default 20
)
returns json
language sql
stable
security definer
set search_path = public
as $function$
  with profile as (
    select rp.id
    from public.roaster_profiles rp
    where rp.slug = p_slug
      and rp.is_active = true
    limit 1
  )
  select case
    when exists (select 1 from profile) then coalesce(
      (select public.get_roaster_reviews(profile.id, p_offset, p_limit) from profile),
      '[]'::json
    )
    else null
  end;
$function$;

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
        rp.city,
        rp.state,
        rp.country
      ) ilike '%' || filters.normalized_search || '%'
    )
  order by public.immutable_unaccent(lower(rp.roaster_name)) asc
  offset p_offset
  limit p_limit;
$function$;
