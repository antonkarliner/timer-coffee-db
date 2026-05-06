-- Fix immutable_unaccent to use extensions.unaccent explicitly.
-- db push sends RESET ALL before each migration, which strips 'extensions' from
-- search_path. PostgreSQL then fails to inline this SQL function when planning
-- any query that touches coffee_roasters (which has function-based indexes using
-- this function).
create or replace function public.immutable_unaccent(text)
returns text language sql immutable as $$
  select extensions.unaccent($1)
$$;

-- Migration: auto-create roaster_profiles for every coffee_roaster
--
-- Every roaster in the coffee_roasters table gets an automatic profile page.
-- The slug defaults to the coffee_roasters.id cast to text.
-- Roaster admins can later claim the profile and set a custom slug.

-- 1. Default is_active to true — every roaster is publicly visible.
alter table public.roaster_profiles
  alter column is_active set default true;

-- 2. Backfill: create profiles for all existing coffee_roasters without one.
insert into public.roaster_profiles (coffee_roaster_id, slug, is_active)
select
  cr.id,
  cr.id::text,
  true
from public.coffee_roasters cr
where not exists (
  select 1
  from public.roaster_profiles rp
  where rp.coffee_roaster_id = cr.id
)
on conflict (slug) do nothing;

-- 3. Trigger function: auto-create a profile whenever a new coffee_roaster is inserted.
create or replace function public.create_roaster_profile_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.roaster_profiles (coffee_roaster_id, slug, is_active)
  values (new.id, new.id::text, true)
  on conflict do nothing;
  return new;
end;
$$;

-- 4. Attach trigger to coffee_roasters.
drop trigger if exists trg_create_roaster_profile on public.coffee_roasters;
create trigger trg_create_roaster_profile
  after insert on public.coffee_roasters
  for each row
  execute function public.create_roaster_profile_on_insert();
