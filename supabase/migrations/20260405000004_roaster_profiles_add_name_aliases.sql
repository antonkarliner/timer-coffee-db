-- Add roaster_name and aliases to roaster_profiles so it is fully self-contained.
-- Drop the remaining join on coffee_roasters from both RPCs.
-- Add an UPDATE trigger on coffee_roasters to sync unclaimed profiles
-- (handles async mirror URL generation and any future corrections).

-- 1. Add columns.
alter table public.roaster_profiles
  add column if not exists roaster_name text,
  add column if not exists aliases      text;

-- 2. Backfill.
update public.roaster_profiles rp
set
  roaster_name = cr.roaster_name,
  aliases      = cr.aliases
from public.coffee_roasters cr
where cr.id = rp.coffee_roaster_id;

-- 3. Update INSERT trigger to also copy name and aliases.
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
    roaster_name,
    aliases,
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
    new.roaster_name,
    new.aliases,
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

-- 4. UPDATE trigger: sync unclaimed profiles when coffee_roasters row changes.
--    This handles async mirror URL generation and any manual corrections.
--    Claimed profiles (admin_user_id IS NOT NULL) are never touched.
create or replace function public.sync_roaster_profile_on_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.roaster_profiles
  set
    roaster_name            = new.roaster_name,
    aliases                 = new.aliases,
    roaster_logo_url        = new.roaster_logo_url,
    roaster_logo_mirror_url = new.roaster_logo_mirror_url,
    website_url             = new.roaster_website_url,
    city                    = new.city,
    state                   = new.state,
    country                 = new.country,
    address_text            = new.address_text
  where coffee_roaster_id = new.id
    and admin_user_id is null;
  return new;
end;
$$;

drop trigger if exists trg_sync_roaster_profile on public.coffee_roasters;
create trigger trg_sync_roaster_profile
  after update on public.coffee_roasters
  for each row
  execute function public.sync_roaster_profile_on_update();

-- 5. get_roaster_profile: no more join — query roaster_profiles only.
create or replace function public.get_roaster_profile(p_slug text)
returns json
language sql
stable
security definer
as $$
  select row_to_json(t)
  from (
    select
      id,
      slug,
      coffee_roaster_id,
      admin_user_id,
      roaster_name,
      roaster_logo_url,
      roaster_logo_mirror_url,
      website_url,
      description,
      city,
      state,
      country,
      address_text,
      instagram_url,
      twitter_url,
      facebook_url,
      tiktok_url,
      is_active
    from public.roaster_profiles
    where slug = p_slug
      and is_active = true
    limit 1
  ) t;
$$;

-- 6. get_roaster_profile_by_name: no more join — query roaster_profiles only.
create or replace function public.get_roaster_profile_by_name(p_roaster_name text)
returns json
language sql
stable
security definer
as $$
  select row_to_json(t)
  from (
    select id, slug
    from public.roaster_profiles
    where is_active = true
      and (
        lower(extensions.unaccent(roaster_name)) = lower(extensions.unaccent(p_roaster_name))
        or lower(extensions.unaccent(coalesce(aliases, ''))) ilike '%' || lower(extensions.unaccent(p_roaster_name)) || '%'
      )
    limit 1
  ) t;
$$;
