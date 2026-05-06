-- list_roaster_profiles: paginated catalog with search + country filter
CREATE OR REPLACE FUNCTION list_roaster_profiles(
  p_search   text    DEFAULT NULL,
  p_country  text    DEFAULT NULL,
  p_offset   int     DEFAULT 0,
  p_limit    int     DEFAULT 30
)
RETURNS TABLE (
  id                      uuid,
  slug                    text,
  roaster_name            text,
  city                    text,
  state                   text,
  country                 text,
  roaster_logo_url        text,
  roaster_logo_mirror_url text,
  dominant_color_hex      text,
  admin_user_id           text,
  is_active               boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
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
  FROM roaster_profiles rp
  WHERE
    rp.is_active = true
    AND (
      p_country IS NULL
      OR rp.country = p_country
    )
    AND (
      p_search IS NULL
      OR p_search = ''
      OR extensions.unaccent(lower(rp.roaster_name)) ILIKE '%' || extensions.unaccent(lower(p_search)) || '%'
      OR extensions.unaccent(lower(coalesce(rp.city, '')))    ILIKE '%' || extensions.unaccent(lower(p_search)) || '%'
      OR extensions.unaccent(lower(coalesce(rp.country, ''))) ILIKE '%' || extensions.unaccent(lower(p_search)) || '%'
    )
  ORDER BY
    lower(extensions.unaccent(rp.roaster_name)) ASC
  OFFSET p_offset
  LIMIT  p_limit;
$$;

-- get_roaster_countries: distinct active countries ordered by roaster count
CREATE OR REPLACE FUNCTION get_roaster_countries()
RETURNS TABLE (
  country       text,
  roaster_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    rp.country,
    count(*) AS roaster_count
  FROM roaster_profiles rp
  WHERE
    rp.is_active = true
    AND rp.country IS NOT NULL
    AND rp.country <> ''
  GROUP BY rp.country
  ORDER BY roaster_count DESC, rp.country ASC;
$$;
