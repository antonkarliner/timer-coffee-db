-- Merged roaster directory lookup: returns logo assets + profile ref in one
-- round trip for a free-text roaster name. Replaces the client-side pair of
-- calls (search_roaster_unaccent + get_roaster_profile_by_name) that queried
-- roaster_profiles twice with the same matching logic. Both old functions are
-- kept for app versions already in the wild.
--
-- Matching mirrors search_roaster_unaccent: exact unaccented name match wins
-- over an alias substring match.

create or replace function public.get_roaster_bundle_by_name(p_roaster_name text)
returns table (
  profile_id uuid,
  slug text,
  roaster_logo_url text,
  roaster_logo_mirror_url text,
  dominant_color_hex text
)
language sql
stable security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
  select
    id as profile_id,
    slug,
    roaster_logo_url,
    roaster_logo_mirror_url,
    dominant_color_hex
  from public.roaster_profiles
  where is_active = true
    and (
      extensions.unaccent(lower(roaster_name)) = extensions.unaccent(lower(p_roaster_name))
      or extensions.unaccent(lower(coalesce(aliases, ''))) ilike '%' || extensions.unaccent(lower(p_roaster_name)) || '%'
    )
  order by
    case when extensions.unaccent(lower(roaster_name)) = extensions.unaccent(lower(p_roaster_name))
         then 0 else 1 end
  limit 1;
$$;

grant execute on function public.get_roaster_bundle_by_name(text)
  to anon, authenticated, service_role;
