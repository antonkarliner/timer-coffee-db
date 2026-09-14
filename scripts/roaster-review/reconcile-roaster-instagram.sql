/*
  Read-only Instagram reconciliation for the roaster-review workflow.

  Run this in the Supabase SQL editor after every roaster-review batch and
  after the Plan 030 rollout. This file uses one UNION ALL result set so it is
  copy-pasteable as a single query. Every labeled section must return zero rows;
  quote section, entity_id, and related_id in any failure report.
*/

with duplicate_accounts as (
  select lower(public.canonicalize_instagram_url(instagram_url)) as account_url
  from public.roaster_profiles
  where public.canonicalize_instagram_url(instagram_url) is not null
  group by lower(public.canonicalize_instagram_url(instagram_url))
  having count(*) >= 2
)
select
  '1_coffee_roasters_instagram_website'::text as section,
  cr.id::text as entity_id,
  null::text as related_id,
  cr.roaster_name::text as roaster_name,
  cr.roaster_website_url::text as offending_url,
  'coffee_roasters.roaster_website_url contains an Instagram host'::text as details
from public.coffee_roasters as cr
where public.is_instagram_website_url(cr.roaster_website_url)

union all

select
  '2_roaster_profiles_instagram_website',
  rp.id::text,
  rp.coffee_roaster_id::text,
  rp.roaster_name::text,
  rp.website_url::text,
  'roaster_profiles.website_url contains an Instagram host'
from public.roaster_profiles as rp
where public.is_instagram_website_url(rp.website_url)

union all

select
  '3_noncanonical_profile_instagram',
  rp.id::text,
  rp.coffee_roaster_id::text,
  rp.roaster_name::text,
  rp.instagram_url::text,
  'instagram_url is not exactly the canonical account-profile URL'
from public.roaster_profiles as rp
where rp.instagram_url is not null
  and (
    public.canonicalize_instagram_url(rp.instagram_url) is null
    or rp.instagram_url is distinct from public.canonicalize_instagram_url(rp.instagram_url)
  )

union all

select
  '4_duplicate_instagram_account',
  rp.id::text,
  rp.coffee_roaster_id::text,
  rp.roaster_name::text,
  rp.instagram_url::text,
  'multiple profile rows resolve case-insensitively to ' || da.account_url
from public.roaster_profiles as rp
join duplicate_accounts as da
  on lower(public.canonicalize_instagram_url(rp.instagram_url)) = da.account_url

union all

select
  '5_missing_system_profile',
  cr.id::text,
  null::text,
  cr.roaster_name::text,
  null::text,
  'coffee_roasters row has no system profile; approved Instagram cannot be propagated'
from public.coffee_roasters as cr
where not exists (
  -- Deliberately NOT filtered on admin_user_id: a profile claimed by its
  -- roaster owner is a normal, healthy state, not a missing profile. Adding
  -- that filter here reported five owner-claimed roasters as violations.
  select 1
  from public.roaster_profiles as rp
  where rp.coffee_roaster_id = cr.id
)

order by section, entity_id, related_id;
