-- Roaster duplicate matching: replace the alias substring rule with
-- whole-word matching scored by how distinctive the search term is.
--
-- The defect, found 2026-09-17 while running the plan-034 2.1 roaster-link
-- evaluation. Both public.find_potential_roaster_matches and
-- public.find_potential_roaster_matches_with_vector carried this rule:
--
--   where cr.normalized_aliases ilike '%' || search_normalized_name || '%'
--   ... 0.9 as conf
--
-- Any substring hit anywhere inside the comma-joined alias blob returned a
-- flat 0.9, with no length guard and no relation to how much of the alias was
-- matched. 0.9 clears the default min_confidence of 0.65, so these always
-- survived filtering and, since the 20260916215000 ranking fix made the top-N
-- selection honour confidence, they crowded out real trigram matches.
-- Measured on production: searching 'a' returned 943 roasters at 0.9, 'me'
-- returned 48, 'nn' returned 14. Real scanned strings produced "Me" ->
-- "Merit Coffee Co", "NN" -> "JB Kaffee", "Loom" -> "Sweet Bloom Coffee
-- Roasters", "Bay Coffee Roasters" -> "Arabay" (alias "arabay coffee
-- roasters"), each labelled 0.9. 182 distinct scanned roaster strings in
-- global_coffee_beans are 1-3 characters, covering 459 bean rows.
--
-- Today the only caller is roaster-enrichment-worker, which feeds the result
-- into an admin review queue rather than merging automatically, so the cost is
-- a polluted queue. Plan 034 2.2 and 4.1 propose linking on this confidence,
-- which is why this is fixed first.
--
-- ---------------------------------------------------------------------------
-- What the rule became, and why, measured against the 3,477 distinct scanned
-- roaster strings in global_coffee_beans that do not equal a catalog name.
--
-- 1. WHOLE-WORD MATCHING, not substring. Both sides collapse every run of
--    non-alphanumeric characters to a single space, then the search must sit
--    on word boundaries inside an alias token. This alone removes 61% of the
--    rule's (search, roaster) pairs -- 4,078 down to 1,583 -- while only 9% of
--    searches lose their alias hits entirely. It kills every false positive
--    listed above, and the delimiter collapsing additionally repairs real
--    matches the old ILIKE missed because the alias text carries JSON array
--    artifacts: '{coffeecircle}' now matches "coffeecircle", '{"jj bean"}'
--    matches "jj bean", 'terrone & co.' matches "terrone & co".
--
-- 2. SCORED BY AMBIGUITY, not by coverage. The obvious fix -- score by
--    length(search)/length(alias), or by similarity() against the matched
--    alias -- was measured and rejected: coverage does not track correctness
--    here. In the low-coverage band sit true matches ("hex" -> Hex Coffee at
--    0.16, "masaki" -> Masaki Coffee Roastery at 0.27, "stramoka" -> Caffe
--    Stramoka at 0.30), and in the high band sit false ones ("coffee" ->
--    Raw Coffee, OZO Coffee, csr coffee, all at 0.60). similarity() tracks
--    coverage almost exactly (per-band average within 0.02), so it fails the
--    same way. What does separate them is how distinctive the search term is:
--    under whole-word matching 1,045 of the 1,083 matched searches (96.5%)
--    hit exactly one roaster, and the many-roaster tail is precisely the
--    generic terms -- "coffee", "coffee roasters", "coffee roastery",
--    "black", "bean", "lab", "brew". So confidence is docked by the number of
--    roasters the rule matched for that search:
--
--      conf = (0.96 if the alias token equals the search else 0.85)
--             - 0.15 * ln(roasters matched)
--
--    One roaster matched keeps the base. Two costs 0.10, five costs 0.24,
--    ten costs 0.35. Generic terms sink below any plausible min_confidence on
--    their own, with no stopword list to maintain and nothing English-specific
--    in the rule. 0.96 sits below exact_normalized (0.98) and website_host
--    (0.99); 0.85 sits below both and above the trigram band.
--
-- 3. NO BLANKET MINIMUM LENGTH. A 4-character floor was proposed and is wrong
--    as a blanket rule: short searches are overwhelmingly correct here. "sey"
--    -> Sey Coffee (36 bean rows), "taf" -> Taf coffee, "hex" -> Hex Coffee,
--    "3fe", "ona", "ucc", "ppp", "qed", "kb", plus CJK and Hangul names where
--    2-3 characters is the whole name -- 辛鹿 -> SinloyCoffee, 모모스 ->
--    Momos Coffee, 楓 -> 焙煎珈琲豆 楓. All are exact alias equalities and all
--    match exactly one roaster. The floor therefore applies only to the
--    partial branch: an alias token must equal the search to match below 4
--    characters. That drops the junk 1-character hits ("1", "t") and costs
--    five real partial hits of one bean row each.
--
-- Net effect on that workload: 4,078 alias pairs at a flat 0.9 become 1,091
-- pairs at or above 0.65, spread across a real confidence range.

-- ---------------------------------------------------------------------------
-- The rule, factored out so the two matchers cannot drift apart again.

create or replace function public.roaster_alias_match_candidates(
  search_normalized_name text
)
returns table (
  roaster_id bigint,
  roaster_name text,
  confidence double precision,
  match_method text
)
language sql
stable
-- Nothing here needs the extensions schema, but the callers inline this body
-- and both of them do; keeping the search_path identical avoids surprises.
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  with search as (
    -- Collapse every non-alphanumeric run to one space so that punctuation,
    -- quoting and the JSON artifacts in normalized_aliases cannot hide a word
    -- boundary. [:alnum:] keeps CJK and Hangul, verified against the live
    -- aliases for 辛鹿, 모모스 and 楓.
    select btrim(
             regexp_replace(
               coalesce(search_normalized_name, ''), '[^[:alnum:]]+', ' ', 'g'
             )
           ) as q
  ),
  alias_tokens as (
    -- normalized_aliases is the comma-joined form written by the
    -- normalize_roaster_fields trigger, so commas are the token separator.
    select
      cr.id as r_id,
      cr.roaster_name as r_name,
      btrim(regexp_replace(btrim(t), '[^[:alnum:]]+', ' ', 'g')) as alias
    from public.coffee_roasters cr
    cross join lateral unnest(
      string_to_array(coalesce(cr.normalized_aliases, ''), ',')
    ) as t
    where btrim(regexp_replace(btrim(t), '[^[:alnum:]]+', ' ', 'g')) <> ''
  ),
  hits as (
    -- One row per roaster. A roaster that matches both ways counts as exact.
    select
      at.r_id,
      at.r_name,
      bool_or(at.alias = s.q) as is_exact
    from alias_tokens at
    cross join search s
    where s.q <> ''
      and (
        at.alias = s.q
        -- Padding both sides is what makes this a whole-word test: the search
        -- has to be delimited by a space or by the end of the alias token.
        or (
          length(s.q) >= 4
          and ' ' || at.alias || ' ' like '% ' || s.q || ' %'
        )
      )
    group by at.r_id, at.r_name
  ),
  scored as (
    select
      h.r_id,
      h.r_name,
      h.is_exact,
      -- hits is one row per roaster, so this is the number of roasters this
      -- search reaches through aliases -- computed before any confidence
      -- filtering, because that is the whole point of it.
      count(*) over () as ambiguity
    from hits h
  )
  select
    sc.r_id as roaster_id,
    sc.r_name as roaster_name,
    greatest(
      0::numeric,
      (case when sc.is_exact then 0.96 else 0.85 end)::numeric
        - 0.15 * ln(greatest(sc.ambiguity, 1)::numeric)
    )::double precision as confidence,
    (case when sc.is_exact then 'alias_exact' else 'alias_token' end)::text
      as match_method
  from scored sc;
$function$;

comment on function public.roaster_alias_match_candidates(text) is
  'Roasters whose normalized_aliases contain the search as a whole word, '
  'scored 0.96 (alias token equals the search) or 0.85 (whole-word span '
  'inside one), each docked 0.15 * ln(number of roasters matched) so that '
  'generic terms fall below any useful min_confidence. Replaces an ILIKE '
  'substring rule that returned a flat 0.9 for any substring hit. Does not '
  'apply min_confidence -- callers filter.';

-- ---------------------------------------------------------------------------
-- The primary matcher. Signature unchanged, so CREATE OR REPLACE keeps the
-- existing ACL; only the alias rule differs from 20260916215000.

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

    -- Alias match: whole-word, scored by how distinctive the search is.
    -- See roaster_alias_match_candidates and the header of this migration.
    select
      a.roaster_id,
      a.roaster_name,
      a.confidence,
      a.match_method
    from public.roaster_alias_match_candidates(search_normalized_name) a
    where a.confidence >= min_confidence

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
  'on website host (strongest), exact normalized name, whole-word alias match, '
  'and trigram similarity, returning the top max_results by confidence. '
  'search_website_url is the enrichment-resolved official URL and may be null.';

-- ---------------------------------------------------------------------------
-- The vector variant carried a verbatim copy of the alias rule, and also the
-- top-N ranking bug that 20260916215000 fixed in the primary matcher (its
-- DISTINCT ON forces ORDER BY to lead with id, so LIMIT truncates to the
-- lowest ids rather than the best matches). It has no application caller
-- today -- nothing outside migrations references it, and roaster embeddings
-- were never backfilled -- but leaving a known-broken copy in place is how
-- the alias rule came to exist in two places to begin with. Both defects are
-- fixed here and the alias rule now comes from the shared helper.
--
-- CREATE OR REPLACE resets a function's SET clauses to whatever the command
-- specifies, so the search_path that 20260514120002 attached with ALTER
-- FUNCTION has to be restated here or it would be silently dropped.

create or replace function public.find_potential_roaster_matches_with_vector(
  search_normalized_name text,
  search_display_name text,
  query_embedding vector(384) default null,
  max_results integer default 3,
  min_confidence double precision default 0.65
)
returns table (
  roaster_id bigint,
  roaster_name text,
  confidence double precision,
  match_method text
)
language sql
stable
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
  with all_matches as (
    -- Vector matches (if embedding provided)
    select
      v.roaster_id as id,
      v.roaster_name,
      v.similarity_score as conf,
      'vector_cosine'::text as method
    from public.search_roasters_by_vector(query_embedding, min_confidence, max_results) v
    where query_embedding is not null

    union all

    select
      cr.id,
      cr.roaster_name,
      similarity(cr.normalized_name, search_normalized_name) as conf,
      'trigram_normalized'::text as method
    from public.coffee_roasters cr
    where similarity(cr.normalized_name, search_normalized_name) >= min_confidence

    union all

    select
      cr.id,
      cr.roaster_name,
      similarity(lower(unaccent(cr.roaster_name)), search_normalized_name) as conf,
      'trigram_name'::text as method
    from public.coffee_roasters cr
    where similarity(lower(unaccent(cr.roaster_name)), search_normalized_name)
          >= min_confidence

    union all

    select
      a.roaster_id,
      a.roaster_name,
      a.confidence,
      a.match_method
    from public.roaster_alias_match_candidates(search_normalized_name) a
    where a.confidence >= min_confidence

    union all

    select
      cr.id,
      cr.roaster_name,
      0.98 as conf,
      'exact_normalized'::text as method
    from public.coffee_roasters cr
    where cr.normalized_name = search_normalized_name
  ),
  deduped as (
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

comment on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) is
  'Finds potential matching roasters using vector similarity (if an embedding '
  'is supplied), exact normalized name, whole-word alias match and trigram '
  'similarity, returning the top max_results by confidence. No application '
  'caller today; kept in step with find_potential_roaster_matches.';

-- ---------------------------------------------------------------------------
-- Grants.
--
-- ALTER DEFAULT PRIVILEGES on this database grants EXECUTE to anon,
-- authenticated and service_role on newly created public functions, and those
-- are grants to named roles -- revoking from the PUBLIC pseudo-role does not
-- touch them. roaster_alias_match_candidates is new, so it needs the named
-- revokes. The two matchers are replaced rather than created, which preserves
-- their ACLs, but they are restated here so the end state is readable in one
-- place and so a future CREATE (rather than REPLACE) cannot reopen the hole.

revoke execute on function public.roaster_alias_match_candidates(text) from public;
revoke execute on function public.roaster_alias_match_candidates(text) from anon;
revoke execute on function public.roaster_alias_match_candidates(text) from authenticated;
grant execute on function public.roaster_alias_match_candidates(text) to service_role;
grant execute on function public.roaster_alias_match_candidates(text) to postgres;

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

revoke execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) from public;
revoke execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) from anon;
revoke execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) from authenticated;
grant execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) to service_role;
grant execute on function public.find_potential_roaster_matches_with_vector(
  text, text, vector, integer, double precision
) to postgres;
