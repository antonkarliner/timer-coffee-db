-- Roaster duplicate matching: add website-host matching and fix top-N ranking.
--
-- Two defects in public.find_potential_roaster_matches, both measured against
-- 120 days of production data (92 clusters that reviewers resolved as aliases
-- of an existing roaster):
--
--   1. The website is never considered. The enrichment worker resolves the
--      roaster's official URL during extract/validate and then calls this
--      function with names only, discarding the single most discriminating
--      identifier it has. Of the 67 aliases this function failed to surface,
--      42 had an exact domain match with the roaster they were aliased to.
--      Examples that name matching cannot reach in principle:
--        "Southern Weather"  -> Onyx Coffee Lab      (onyxcoffeelab.com)
--        "Estd Coffee"       -> Established Coffee   (established.coffee)
--        "Climp & Sons"      -> Climpson and Sons    (climpsonandsons.com)
--        "Rouge Wave"        -> Rogue Wave Coffee    (roguewavecoffee.ca)
--      The first is a coffee blend name a user typed into the roaster field;
--      it has no lexical or semantic relationship to the roaster at all.
--
--   2. The top-N selection returns the wrong rows. The final clause was
--        SELECT DISTINCT ON (id) ... ORDER BY id, conf DESC LIMIT max_results
--      DISTINCT ON forces ORDER BY to lead with id, so the result set comes
--      out ordered by id and LIMIT truncates to the lowest ids rather than
--      the best matches. Verified on production: searching 'coffee' returned
--      ids 3, 4, 6 (Friedhats, KB Coffee Roasters, DAK) while id 553
--      "Coffee++" at similarity 1.000 was discarded. Every caller has been
--      receiving near-arbitrary matches. Fixed by deduping in a subquery and
--      ranking the deduped set by confidence.
--
-- Domain matching is safe here: 1,329 roasters carry a website and 1,321 of
-- those hosts are distinct (99.4% unique). Measured against clusters that
-- reviewers approved as genuinely new roasters, the host rule produces two
-- false positives in 240, both caused by a shared platform URL sitting in
-- roaster_website_url (facebook.com on one row, tokopedia.com on two). The
-- shared_hosts exclusion below removes both.

-- The new signature adds a fifth parameter, which would otherwise create an
-- overload and make PostgREST's named-argument resolution ambiguous. Drop the
-- 4-argument version first; this migration runs in a transaction, so there is
-- no window where neither exists.
drop function if exists public.find_potential_roaster_matches(
  text, text, integer, double precision
);

create or replace function public.find_potential_roaster_matches(
  search_normalized_name text,
  search_display_name text,
  max_results integer default 3,
  min_confidence double precision default 0.65,
  search_website_url text default null
)
returns table (
  roaster_id bigint,
  roaster_name text,
  confidence double precision,
  match_method text
)
language sql
stable
-- unaccent() lives in the extensions schema and a LANGUAGE SQL body resolves
-- names at creation time, so extensions must stay on the search_path here.
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  with shared_hosts(host) as (
    -- Hosts that many unrelated roasters legitimately share. A match on one
    -- of these says nothing about identity, so they are excluded from the
    -- host rule on both sides.
    select unnest(array[
      'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
      'linkedin.com', 'reddit.com', 'threads.com', 'threads.net',
      'youtube.com', 'linktr.ee', 'tokopedia.com', 'shopee.co.id',
      'etsy.com', 'amazon.com', 'ebay.com', 'wa.me', 't.me',
      'google.com', 'sites.google.com', 'wixsite.com', 'myshopify.com',
      'square.site', 'bigcartel.com'
    ])
  ),
  search_host as (
    select candidate.host
    from (
      select nullif(
        split_part(
          regexp_replace(
            regexp_replace(
              lower(btrim(coalesce(search_website_url, ''))),
              '^https?://', ''
            ),
            '^www\.', ''
          ),
          '/', 1
        ),
        ''
      ) as host
    ) as candidate
    where candidate.host is not null
      and candidate.host not in (select host from shared_hosts)
  ),
  all_matches as (
    -- Exact website host. Ranked above exact_normalized because two roasters
    -- sharing a domain is rarer than two sharing a normalized name.
    select
      cr.id,
      cr.roaster_name,
      0.99::double precision as conf,
      'website_host'::text as method
    from public.coffee_roasters cr
    cross join search_host s
    where nullif(
            split_part(
              regexp_replace(
                regexp_replace(
                  lower(btrim(coalesce(cr.roaster_website_url, ''))),
                  '^https?://', ''
                ),
                '^www\.', ''
              ),
              '/', 1
            ),
            ''
          ) = s.host

    union all

    -- Exact normalized name match
    select
      cr.id,
      cr.roaster_name,
      0.98 as conf,
      'exact_normalized'::text as method
    from public.coffee_roasters cr
    where cr.normalized_name = search_normalized_name

    union all

    -- Alias substring match
    select
      cr.id,
      cr.roaster_name,
      0.9 as conf,
      'alias_substring'::text as method
    from public.coffee_roasters cr
    where cr.normalized_aliases ilike '%' || search_normalized_name || '%'
      and search_normalized_name != ''

    union all

    -- Trigram similarity on normalized_name
    select
      cr.id,
      cr.roaster_name,
      similarity(cr.normalized_name, search_normalized_name) as conf,
      'trigram_normalized'::text as method
    from public.coffee_roasters cr
    where similarity(cr.normalized_name, search_normalized_name) >= min_confidence

    union all

    -- Trigram on roaster_name
    select
      cr.id,
      cr.roaster_name,
      similarity(lower(unaccent(cr.roaster_name)), search_normalized_name) as conf,
      'trigram_name'::text as method
    from public.coffee_roasters cr
    where similarity(lower(unaccent(cr.roaster_name)), search_normalized_name)
          >= min_confidence
  ),
  deduped as (
    -- DISTINCT ON requires ORDER BY to lead with id, so keeping the best
    -- method per roaster and ranking the result set are separate steps.
    select distinct on (all_matches.id)
      all_matches.id,
      all_matches.roaster_name,
      all_matches.conf,
      all_matches.method
    from all_matches
    order by all_matches.id, all_matches.conf desc
  )
  select
    deduped.id as roaster_id,
    deduped.roaster_name,
    deduped.conf as confidence,
    deduped.method as match_method
  from deduped
  order by deduped.conf desc, deduped.id
  limit max_results;
$function$;

comment on function public.find_potential_roaster_matches(
  text, text, integer, double precision, text
) is
  'Surfaces existing roasters that a candidate cluster may duplicate. Matches '
  'on website host (strongest), exact normalized name, alias substring, and '
  'trigram similarity, returning the top max_results by confidence. '
  'search_website_url is the enrichment-resolved official URL and may be null.';

-- Grants. ALTER DEFAULT PRIVILEGES on this database grants EXECUTE to anon,
-- authenticated and service_role on newly created public functions, and those
-- are grants to named roles -- revoking from the PUBLIC pseudo-role does not
-- touch them. The previous version of this function ended up as
-- {=X, postgres=X, anon=X, authenticated=X, service_role=X}; it is an internal
-- matching helper for the enrichment worker, and 24h of PostgREST logs show
-- the Edge Runtime (service_role) as its only caller.
revoke execute on function public.find_potential_roaster_matches(
  text, text, integer, double precision, text
) from public;
revoke execute on function public.find_potential_roaster_matches(
  text, text, integer, double precision, text
) from anon;
revoke execute on function public.find_potential_roaster_matches(
  text, text, integer, double precision, text
) from authenticated;
grant execute on function public.find_potential_roaster_matches(
  text, text, integer, double precision, text
) to service_role;
grant execute on function public.find_potential_roaster_matches(
  text, text, integer, double precision, text
) to postgres;
