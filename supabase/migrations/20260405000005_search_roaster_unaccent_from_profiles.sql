-- Drop first: return type is changing from SETOF coffee_roasters to a narrow 2-column table.
drop function if exists public.search_roaster_unaccent(text);

-- Redirect search_roaster_unaccent to query roaster_profiles instead of coffee_roasters.
-- roaster_profiles is now the source of truth for logo URLs, name, and aliases.
-- Return type keeps the same column names so existing app versions continue to work.

create or replace function public.search_roaster_unaccent(search_name text)
returns table (
  roaster_logo_url        text,
  roaster_logo_mirror_url text
)
language sql
stable
security definer
as $$
  select
    roaster_logo_url,
    roaster_logo_mirror_url
  from public.roaster_profiles
  where is_active = true
    and (
      extensions.unaccent(lower(roaster_name)) = extensions.unaccent(lower(search_name))
      or extensions.unaccent(lower(coalesce(aliases, ''))) ilike '%' || extensions.unaccent(lower(search_name)) || '%'
    )
  order by
    case when extensions.unaccent(lower(roaster_name)) = extensions.unaccent(lower(search_name))
         then 0 else 1 end
  limit 1;
$$;
