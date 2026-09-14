-- Plan 030, part 1 of 2: Instagram URL routing — producers and the atomic
-- create path. NO strict constraints are added here.
--
-- Rollout order (plan 030 section 7, which must not be reordered):
--   1. apply THIS migration
--   2. deploy the producers (submit-roaster-contribution,
--      roaster-enrichment-worker) and add-roaster
--   3. run scripts/roaster-review/reconcile-roaster-instagram.sql against
--      production and require zero rows
--   4. only then apply 20260914174600_roaster_instagram_url_constraints.sql
--
-- Split from a single file so step 3's reconciliation gate can run between the
-- producers landing and the CHECK constraints being enforced: the gate query
-- depends on the helper functions defined below, and the constraints must not
-- be enabled while any producer can still write an Instagram URL into a
-- website column.

-- A roaster may legitimately have an official Instagram account and no
-- independent website (plan 030, required behavior 3). The contribution intake
-- therefore has to be able to store an Instagram-only submission, which the
-- NOT NULL on website_url currently forbids. Instagram-only rows carry a null
-- website_url and a null website_domain; the edge function still rejects a
-- submission that yields neither a website nor an Instagram account, so this
-- does not weaken intake validation.
alter table service.roaster_candidate_contributions
  alter column website_url drop not null;

-- Return one canonical Instagram account-profile URL, or null when the input
-- is blank or is not a supported account-profile URL. The regex accepts one
-- optional subdomain label; query strings and fragments are deliberately not
-- part of the captured handle and are discarded from the result.
create or replace function public.canonicalize_instagram_url(p_value text)
returns text
language sql
immutable
set search_path = public
as $fn$
  with matched as (
    select regexp_match(
      btrim(p_value, E' \t\n\r\f'),
      '^https?://(?:(?:[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])[.])?(?:instagram[.]com|instagr[.]am)/([a-z0-9._]{1,30})/?(?:[?][^#]*)?(?:#.*)?$',
      'i'
    ) as parts
    where p_value is not null
      and btrim(p_value, E' \t\n\r\f') <> ''
  )
  select case
    when parts is null then null
    when parts[1] like '.%' or parts[1] like '%.' then null
    when lower(parts[1]) in (
      'p', 'reel', 'reels', 'stories', 's', 'tv', 'explore', 'share',
      'accounts', 'direct', 'about', 'developer', 'legal', 'privacy',
      'terms', 'api', 'web', 'login', 'signup'
    ) then null
    else 'https://www.instagram.com/' || parts[1] || '/'
  end
  from matched;
$fn$;

comment on function public.canonicalize_instagram_url(text) is
  'Canonicalizes supported Instagram account-profile URLs, discarding query strings and fragments; returns null for blank, reserved, or invalid inputs.';

revoke all on function public.canonicalize_instagram_url(text) from public;

-- Detect an Instagram website host without accepting suffix/prefix lookalikes.
-- Any number of well-formed subdomain labels and an optional numeric port are
-- accepted because this helper classifies the host, not the profile path.
create or replace function public.is_instagram_website_url(p_value text)
returns boolean
language sql
immutable
set search_path = public
as $fn$
  select coalesce(
    btrim(p_value, E' \t\n\r\f') ~*
      '^https?://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])*(?:instagram[.]com|instagr[.]am)(?::[0-9]{1,5})?(?:[/?#]|$)',
    false
  );
$fn$;

comment on function public.is_instagram_website_url(text) is
  'Returns true only when an HTTP(S) URL has instagram.com, instagr.am, or a label-anchored subdomain of either as its host.';

revoke all on function public.is_instagram_website_url(text) from public;

-- Normalize every recognizable existing profile URL without destroying values
-- that cannot be classified. The guard immediately below reports all remaining
-- bad IDs and prevents constraints from being installed over unresolved data.
with normalized as (
  select
    id,
    public.canonicalize_instagram_url(instagram_url) as canonical_url
  from public.roaster_profiles
  where instagram_url is not null
)
update public.roaster_profiles as rp
set
  instagram_url = normalized.canonical_url,
  updated_at = now()
from normalized
where rp.id = normalized.id
  and normalized.canonical_url is not null
  and rp.instagram_url is distinct from normalized.canonical_url;

do $do$
declare
  v_bad_profile_instagram_ids uuid[];
  v_bad_roaster_website_ids bigint[];
  v_bad_profile_website_ids uuid[];
begin
  select array_agg(rp.id order by rp.id)
  into v_bad_profile_instagram_ids
  from public.roaster_profiles as rp
  where rp.instagram_url is not null
    and (
      public.canonicalize_instagram_url(rp.instagram_url) is null
      or rp.instagram_url is distinct from
        public.canonicalize_instagram_url(rp.instagram_url)
    );

  select array_agg(cr.id order by cr.id)
  into v_bad_roaster_website_ids
  from public.coffee_roasters as cr
  where public.is_instagram_website_url(cr.roaster_website_url);

  select array_agg(rp.id order by rp.id)
  into v_bad_profile_website_ids
  from public.roaster_profiles as rp
  where public.is_instagram_website_url(rp.website_url);

  if v_bad_profile_instagram_ids is not null
     or v_bad_roaster_website_ids is not null
     or v_bad_profile_website_ids is not null then
    raise exception
      'Instagram URL reconciliation failed. Noncanonical roaster_profiles.instagram_url IDs: %; coffee_roasters website IDs with Instagram hosts: %; roaster_profiles website IDs with Instagram hosts: %',
      coalesce(v_bad_profile_instagram_ids::text, '{}'),
      coalesce(v_bad_roaster_website_ids::text, '{}'),
      coalesce(v_bad_profile_website_ids::text, '{}');
  end if;
end;
$do$;

-- Create the base roaster and its trigger-generated system profile atomically,
-- then attach the canonical Instagram URL to exactly that one profile.
create or replace function public.create_roaster_with_profile(
  p_roaster_name text,
  p_roaster_logo_url text default null,
  p_roaster_website_url text default null,
  p_aliases text default null,
  p_city text default null,
  p_state text default null,
  p_country text default null,
  p_address_text text default null,
  p_instagram_url text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_roaster_id bigint;
  v_roaster public.coffee_roasters;
  v_profile public.roaster_profiles;
  v_profile_ids uuid[];
  v_profile_update_count integer;
  v_roaster_name text;
  v_instagram_url text;
begin
  v_roaster_name := nullif(btrim(p_roaster_name, E' \t\n\r\f'), '');

  if v_roaster_name is null then
    raise exception 'Roaster name is required' using errcode = '22023';
  end if;

  if public.is_instagram_website_url(p_roaster_website_url) then
    raise exception
      'Roaster website URL must not be an Instagram URL; provide it in p_instagram_url instead'
      using errcode = '22023';
  end if;

  v_instagram_url := public.canonicalize_instagram_url(p_instagram_url);

  if p_instagram_url is not null
     and btrim(p_instagram_url, E' \t\n\r\f') <> ''
     and v_instagram_url is null then
    raise exception 'Invalid Instagram account profile URL: %', p_instagram_url
      using errcode = '22023';
  end if;

  insert into public.coffee_roasters (
    roaster_name,
    roaster_logo_url,
    roaster_website_url,
    aliases,
    city,
    state,
    country,
    address_text
  ) values (
    v_roaster_name,
    nullif(btrim(p_roaster_logo_url, E' \t\n\r\f'), ''),
    nullif(btrim(p_roaster_website_url, E' \t\n\r\f'), ''),
    nullif(btrim(p_aliases, E' \t\n\r\f'), ''),
    nullif(btrim(p_city, E' \t\n\r\f'), ''),
    nullif(btrim(p_state, E' \t\n\r\f'), ''),
    nullif(btrim(p_country, E' \t\n\r\f'), ''),
    nullif(btrim(p_address_text, E' \t\n\r\f'), '')
  )
  returning id into v_roaster_id;

  if v_instagram_url is not null then
    update public.roaster_profiles
    set
      instagram_url = v_instagram_url,
      updated_at = now()
    where coffee_roaster_id = v_roaster_id;

    get diagnostics v_profile_update_count = row_count;

    if v_profile_update_count <> 1 then
      raise exception
        'Expected exactly one system profile for new roaster %, updated %',
        v_roaster_id,
        v_profile_update_count;
    end if;
  end if;

  select array_agg(rp.id order by rp.id)
  into v_profile_ids
  from public.roaster_profiles as rp
  where rp.coffee_roaster_id = v_roaster_id;

  if coalesce(cardinality(v_profile_ids), 0) <> 1 then
    raise exception
      'Expected exactly one system profile for new roaster %, found %',
      v_roaster_id,
      coalesce(cardinality(v_profile_ids), 0);
  end if;

  select cr.*
  into v_roaster
  from public.coffee_roasters as cr
  where cr.id = v_roaster_id;

  select rp.*
  into v_profile
  from public.roaster_profiles as rp
  where rp.id = v_profile_ids[1];

  return json_build_object(
    'roaster_id', v_roaster.id,
    'profile_id', v_profile.id,
    'roaster_name', v_roaster.roaster_name,
    'roaster_logo_url', v_roaster.roaster_logo_url,
    'roaster_website_url', v_roaster.roaster_website_url,
    'aliases', v_roaster.aliases,
    'city', v_roaster.city,
    'state', v_roaster.state,
    'country', v_roaster.country,
    'address_text', v_roaster.address_text,
    'instagram_url', v_profile.instagram_url
  );
end;
$fn$;

revoke all on function public.create_roaster_with_profile(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) from public;

grant execute on function public.create_roaster_with_profile(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to service_role;

comment on function public.create_roaster_with_profile(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) is
  'Privileged atomic roaster creation path that rejects Instagram website values and writes a canonical Instagram URL to the trigger-created system profile.';

-- Preserve the existing owner-only profile editing behavior and return shape,
-- while validating website/Instagram placement before writing the row.
create or replace function public.update_my_roaster_profile(
  p_slug text default null,
  p_description text default null,
  p_website_url text default null,
  p_city text default null,
  p_state text default null,
  p_country text default null,
  p_address_text text default null,
  p_instagram_url text default null,
  p_twitter_url text default null,
  p_facebook_url text default null,
  p_tiktok_url text default null
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_current_profile public.roaster_profiles;
  v_profile public.roaster_profiles;
  v_slug text;
  v_website_url text;
  v_instagram_url text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into v_current_profile
  from public.roaster_profiles
  where admin_user_id = auth.uid()
  order by updated_at desc nulls last, created_at desc
  limit 1;

  if not found then
    raise exception 'No roaster profile assigned to current user';
  end if;

  v_slug := public.normalize_roaster_profile_slug(p_slug);

  if v_slug is null then
    raise exception 'Slug is required';
  end if;

  if char_length(v_slug) < 2 or char_length(v_slug) > 80 then
    raise exception 'Slug must be between 2 and 80 characters';
  end if;

  if exists (
    select 1
    from public.roaster_profiles rp
    where rp.slug = v_slug
      and rp.id <> v_current_profile.id
  ) then
    raise exception 'That slug is already in use';
  end if;

  if p_website_url is null or btrim(p_website_url, E' \t\n\r\f') = '' then
    v_website_url := null;
  else
    if public.is_instagram_website_url(p_website_url) then
      raise exception
        'Website URL cannot be an Instagram URL. Put it in the Instagram field instead.'
        using errcode = '22023';
    end if;

    v_website_url := p_website_url;
  end if;

  v_instagram_url := public.canonicalize_instagram_url(p_instagram_url);

  if p_instagram_url is not null
     and btrim(p_instagram_url, E' \t\n\r\f') <> ''
     and v_instagram_url is null then
    raise exception
      'Only an Instagram account profile URL is accepted in the Instagram field.'
      using errcode = '22023';
  end if;

  update public.roaster_profiles
  set
    slug = v_slug,
    description = p_description,
    website_url = v_website_url,
    city = p_city,
    state = p_state,
    country = p_country,
    address_text = p_address_text,
    instagram_url = v_instagram_url,
    twitter_url = p_twitter_url,
    facebook_url = p_facebook_url,
    tiktok_url = p_tiktok_url,
    updated_at = now()
  where id = v_current_profile.id
  returning * into v_profile;

  return row_to_json(v_profile);
end;
$fn$;

grant execute on function public.update_my_roaster_profile(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to authenticated;
