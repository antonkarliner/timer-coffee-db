-- Add dominant_color_hex to the search_roaster_unaccent RPC return type
-- so the Flutter bean details screen can read the backend-computed color
-- without falling back to on-device extraction.
-- DROP required because PostgreSQL disallows CREATE OR REPLACE when the
-- return type changes.

DROP FUNCTION IF EXISTS public.search_roaster_unaccent(text);

CREATE FUNCTION public.search_roaster_unaccent(search_name text)
RETURNS TABLE(roaster_logo_url text, roaster_logo_mirror_url text, dominant_color_hex text)
LANGUAGE sql
STABLE SECURITY DEFINER
AS $function$
  SELECT
    roaster_logo_url,
    roaster_logo_mirror_url,
    dominant_color_hex
  FROM public.roaster_profiles
  WHERE is_active = true
    AND (
      extensions.unaccent(lower(roaster_name)) = extensions.unaccent(lower(search_name))
      OR extensions.unaccent(lower(coalesce(aliases, ''))) ILIKE '%' || extensions.unaccent(lower(search_name)) || '%'
    )
  ORDER BY
    CASE WHEN extensions.unaccent(lower(roaster_name)) = extensions.unaccent(lower(search_name))
         THEN 0 ELSE 1 END
  LIMIT 1;
$function$;
