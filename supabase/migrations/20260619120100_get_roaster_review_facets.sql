-- Roaster SEO (Part B): aggregate facets for a roaster's public bean reviews,
-- used to build unique on-page intro text (top flavor tags + origins) and
-- schema-correct per-bean Product aggregateRating markup (beans + avg + count).
--
-- Reviews live in public.bean_reviews and rate individual BEANS, not the roaster
-- as a business. Bean origin comes from the user's own bean record.

CREATE OR REPLACE FUNCTION public.get_roaster_review_facets(p_slug text)
RETURNS json
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_catalog'
AS $function$
  with rp as (
    select id
    from public.roaster_profiles
    where slug = p_slug
    limit 1
  ),
  base as (
    select
      br.id,
      trim(br.bean_name) as bean_name,
      br.rating,
      br.flavor_tags,
      trim(ucb.origin) as bean_origin
    from public.bean_reviews br
    join rp on rp.id = br.roaster_profile_id
    left join public.user_coffee_beans ucb
           on ucb.beans_uuid = br.coffee_beans_uuid
          and ucb.user_id    = br.user_id
    where br.is_public = true
  ),
  tag_counts as (
    select trim(tag) as value, count(*)::int as count
    from base
    cross join lateral unnest(coalesce(base.flavor_tags, '{}'::text[])) as tag
    where nullif(trim(tag), '') is not null
    group by trim(tag)
    order by count desc, value asc
    limit 8
  ),
  origin_counts as (
    select bean_origin as value, count(*)::int as count
    from base
    where nullif(bean_origin, '') is not null
    group by bean_origin
    order by count desc, value asc
    limit 6
  ),
  bean_counts as (
    select
      bean_name,
      count(*)::int as count,
      round(avg(rating)::numeric, 2) as avg_rating
    from base
    where nullif(bean_name, '') is not null
    group by bean_name
    order by count desc, avg_rating desc nulls last
    limit 50
  )
  select json_build_object(
    'review_count', (select count(*)::int from base),
    'avg_rating', (select round(avg(rating)::numeric, 2) from base),
    'flavor_tags', coalesce(
      (select json_agg(json_build_object('value', value, 'count', count)) from tag_counts),
      '[]'::json
    ),
    'origins', coalesce(
      (select json_agg(json_build_object('value', value, 'count', count)) from origin_counts),
      '[]'::json
    ),
    'beans', coalesce(
      (select json_agg(json_build_object('bean_name', bean_name, 'count', count, 'avg_rating', avg_rating)) from bean_counts),
      '[]'::json
    )
  );
$function$;

GRANT EXECUTE ON FUNCTION public.get_roaster_review_facets(text)
  TO anon, authenticated, service_role;
