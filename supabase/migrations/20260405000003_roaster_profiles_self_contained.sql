-- Make roaster_profiles the single source of truth for all roaster data.
--
-- coffee_roasters remains canonical for the enrichment pipeline.
-- roaster_profiles copies data on insert (trigger) and can be freely
-- edited by roaster admins or manually corrected without touching coffee_roasters.

-- 1. Add location/contact columns to roaster_profiles.
alter table public.roaster_profiles
  add column if not exists roaster_logo_url       text,
  add column if not exists roaster_logo_mirror_url text,
  add column if not exists website_url             text,
  add column if not exists city                    text,
  add column if not exists state                   text,
  add column if not exists country                 text,
  add column if not exists address_text            text;

-- 2. Backfill all existing rows from coffee_roasters.
update public.roaster_profiles rp
set
  roaster_logo_url        = cr.roaster_logo_url,
  roaster_logo_mirror_url = cr.roaster_logo_mirror_url,
  website_url             = cr.roaster_website_url,
  city                    = cr.city,
  state                   = cr.state,
  country                 = cr.country,
  address_text            = cr.address_text
from public.coffee_roasters cr
where cr.id = rp.coffee_roaster_id;

-- 3. Update the insert trigger to also copy these fields.
create or replace function public.create_roaster_profile_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.roaster_profiles (
    coffee_roaster_id,
    slug,
    is_active,
    roaster_logo_url,
    roaster_logo_mirror_url,
    website_url,
    city,
    state,
    country,
    address_text
  ) values (
    new.id,
    new.id::text,
    true,
    new.roaster_logo_url,
    new.roaster_logo_mirror_url,
    new.roaster_website_url,
    new.city,
    new.state,
    new.country,
    new.address_text
  )
  on conflict do nothing;
  return new;
end;
$$;

-- 4. Simplify get_roaster_profile — query roaster_profiles only.
create or replace function public.get_roaster_profile(p_slug text)
returns json
language sql
stable
security definer
as $$
  select row_to_json(t)
  from (
    select
      rp.id,
      rp.slug,
      rp.coffee_roaster_id,
      rp.admin_user_id,
      rp.description,
      rp.instagram_url,
      rp.twitter_url,
      rp.facebook_url,
      rp.tiktok_url,
      rp.is_active,
      cr.roaster_name,
      rp.roaster_logo_url,
      rp.roaster_logo_mirror_url,
      rp.website_url,
      rp.city,
      rp.state,
      rp.country,
      rp.address_text
    from public.roaster_profiles rp
    join public.coffee_roasters cr on cr.id = rp.coffee_roaster_id
    where rp.slug = p_slug
      and rp.is_active = true
    limit 1
  ) t;
$$;
