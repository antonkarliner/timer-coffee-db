-- Roaster SEO (Part C): expose roaster_profiles.updated_at through the public
-- catalog RPC so the roaster sitemap can emit an honest <lastmod> per URL instead
-- of the build timestamp. Additive column on the RETURNS TABLE; requires a DROP
-- because the function's result row type changes.

DROP FUNCTION IF EXISTS public.list_roaster_profiles(text, text, integer, integer);

CREATE FUNCTION public.list_roaster_profiles(
  p_search text DEFAULT NULL::text,
  p_country text DEFAULT NULL::text,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 30
)
RETURNS TABLE(
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
  is_active boolean,
  updated_at timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    rp.is_active,
    rp.updated_at
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

GRANT EXECUTE ON FUNCTION public.list_roaster_profiles(text, text, integer, integer)
  TO anon, authenticated, service_role;
