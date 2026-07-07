-- Origin normalization: bean origins are free text entered by users in their
-- own language ("Ethiopia", "Эфиопия", "エチオピア", "Etiopía"), with spelling
-- variants ("Brasil"/"Brazil"), blends ("Kenya/Brazil"), and non-country values
-- ("Blend", "Arabica", "Unknown"). This splits facet counts and leaks foreign
-- languages into the English SEO intro.
--
-- We canonicalize each distinct origin string to ISO 3166-1 alpha-2 country
-- codes ONCE (via the normalize-bean-origins edge function / backfill script,
-- which uses an LLM to handle multilingual / misspelled / blended input) and
-- cache it here, keyed on the normalized string so every distinct origin is
-- paid for at most once and reused across all users and locales. Country names
-- are then rendered per-locale on the client with Intl.DisplayNames — no
-- per-locale name map to maintain.

-- Stable join key for an origin string: trimmed, whitespace-collapsed, lowered.
-- Mirrored in TypeScript (normalize-bean-origins function + backfill script) so
-- cache writes and SQL reads agree on the key.
create or replace function public.normalize_origin_key(p_origin text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select lower(btrim(regexp_replace(coalesce(p_origin, ''), '\s+', ' ', 'g')));
$$;

create table public.bean_origin_normalizations (
  origin_key text primary key,
  raw_sample text not null,
  -- ISO 3166-1 alpha-2 codes. Empty array = recognized as a non-country value
  -- (blend with no discernible origins, "Unknown", processing/variety names),
  -- which is distinct from "not yet normalized" (no row at all).
  country_codes text[] not null default '{}',
  model text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bean_origin_normalizations enable row level security;

-- Readable by anyone (drives public roaster pages); only the service role (edge
-- function / backfill) writes, bypassing RLS. No write policy on purpose.
create policy "bean_origin_normalizations_select_all"
  on public.bean_origin_normalizations for select
  to anon, authenticated
  using (true);

-- Rewrite the roaster facets RPC so origins are returned as ISO country codes,
-- grouped by canonical code. This both fixes the language leak (the client
-- renders the code with Intl.DisplayNames) and dedupes counts that were
-- previously split across spellings/languages. Origins not yet normalized (no
-- cache row) are omitted rather than shown raw — better an honest gap than a
-- foreign-language string in English copy; the backfill/cron closes the gap.
create or replace function public.get_roaster_review_facets(p_slug text)
returns json
language sql
stable security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
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
    select code as value, count(*)::int as count
    from base
    join public.bean_origin_normalizations n
      on n.origin_key = public.normalize_origin_key(base.bean_origin)
    cross join lateral unnest(n.country_codes) as code
    where nullif(base.bean_origin, '') is not null
    group by code
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

grant execute on function public.normalize_origin_key(text)
  to anon, authenticated, service_role;
grant execute on function public.get_roaster_review_facets(text)
  to anon, authenticated, service_role;
