-- Plan 030, part 2 of 2: strict database backstops for Instagram URL routing.
--
-- Apply this ONLY after 20260914174500_roaster_instagram_url_routing.sql is
-- applied, the producers are deployed, and
-- scripts/roaster-review/reconcile-roaster-instagram.sql returns zero rows
-- against the target database. See that migration's header for the full
-- rollout order.
--
-- Each constraint is added NOT VALID, an explicit guard reports every
-- offending id with an actionable message, and only then is the constraint
-- validated. The check expressions are inline anchored regexes rather than
-- calls to the helper functions, because a CHECK that depends on a user
-- function creates dump/restore ordering hazards; they are kept consistent
-- with public.is_instagram_website_url and public.canonicalize_instagram_url.

-- Add restore-safe inline CHECKs as NOT VALID. Existing rows were already
-- reconciled above; the second explicit guard below keeps the failure message
-- actionable before validation scans the tables.
do $do$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'coffee_roasters_website_not_instagram'
      and conrelid = 'public.coffee_roasters'::regclass
  ) then
    alter table public.coffee_roasters
      add constraint coffee_roasters_website_not_instagram
      check (
        roaster_website_url is null
        or btrim(roaster_website_url, E' \t\n\r\f') !~*
          '^https?://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])*(?:instagram[.]com|instagr[.]am)(?::[0-9]{1,5})?(?:[/?#]|$)'
      ) not valid;
  end if;
end;
$do$;

do $do$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'roaster_profiles_website_not_instagram'
      and conrelid = 'public.roaster_profiles'::regclass
  ) then
    alter table public.roaster_profiles
      add constraint roaster_profiles_website_not_instagram
      check (
        website_url is null
        or btrim(website_url, E' \t\n\r\f') !~*
          '^https?://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])*(?:instagram[.]com|instagr[.]am)(?::[0-9]{1,5})?(?:[/?#]|$)'
      ) not valid;
  end if;
end;
$do$;

do $do$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'roaster_profiles_instagram_url_canonical'
      and conrelid = 'public.roaster_profiles'::regclass
  ) then
    alter table public.roaster_profiles
      add constraint roaster_profiles_instagram_url_canonical
      check (
        instagram_url is null
        or instagram_url ~
          '^https://www[.]instagram[.]com/(?!(p|reel|reels|stories|s|tv|explore|share|accounts|direct|about|developer|legal|privacy|terms|api|web|login|signup)/$)([A-Za-z0-9_]|[A-Za-z0-9_][A-Za-z0-9._]{0,28}[A-Za-z0-9_])/$'
      ) not valid;
  end if;
end;
$do$;

do $do$
declare
  v_bad_roaster_website_ids bigint[];
  v_bad_profile_website_ids uuid[];
  v_bad_profile_instagram_ids uuid[];
begin
  select array_agg(cr.id order by cr.id)
  into v_bad_roaster_website_ids
  from public.coffee_roasters as cr
  where cr.roaster_website_url is not null
    and btrim(cr.roaster_website_url, E' \t\n\r\f') ~*
      '^https?://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])*(?:instagram[.]com|instagr[.]am)(?::[0-9]{1,5})?(?:[/?#]|$)';

  select array_agg(rp.id order by rp.id)
  into v_bad_profile_website_ids
  from public.roaster_profiles as rp
  where rp.website_url is not null
    and btrim(rp.website_url, E' \t\n\r\f') ~*
      '^https?://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.])*(?:instagram[.]com|instagr[.]am)(?::[0-9]{1,5})?(?:[/?#]|$)';

  select array_agg(rp.id order by rp.id)
  into v_bad_profile_instagram_ids
  from public.roaster_profiles as rp
  where rp.instagram_url is not null
    and rp.instagram_url !~
      '^https://www[.]instagram[.]com/(?!(p|reel|reels|stories|s|tv|explore|share|accounts|direct|about|developer|legal|privacy|terms|api|web|login|signup)/$)([A-Za-z0-9_]|[A-Za-z0-9_][A-Za-z0-9._]{0,28}[A-Za-z0-9_])/$';

  if v_bad_roaster_website_ids is not null
     or v_bad_profile_website_ids is not null
     or v_bad_profile_instagram_ids is not null then
    raise exception
      'Instagram CHECK guard failed. coffee_roasters website IDs: %; roaster_profiles website IDs: %; roaster_profiles Instagram IDs: %',
      coalesce(v_bad_roaster_website_ids::text, '{}'),
      coalesce(v_bad_profile_website_ids::text, '{}'),
      coalesce(v_bad_profile_instagram_ids::text, '{}');
  end if;
end;
$do$;

alter table public.coffee_roasters
  validate constraint coffee_roasters_website_not_instagram;

alter table public.roaster_profiles
  validate constraint roaster_profiles_website_not_instagram;

alter table public.roaster_profiles
  validate constraint roaster_profiles_instagram_url_canonical;
