alter table public.coffee_roasters
  add column if not exists dominant_color_hex text;

alter table public.roaster_profiles
  add column if not exists dominant_color_hex text;

alter table public.coffee_roasters
  drop constraint if exists coffee_roasters_dominant_color_hex_check;

alter table public.coffee_roasters
  add constraint coffee_roasters_dominant_color_hex_check
  check (
    dominant_color_hex is null
    or dominant_color_hex ~ '^#[0-9A-F]{6}$'
  );

alter table public.roaster_profiles
  drop constraint if exists roaster_profiles_dominant_color_hex_check;

alter table public.roaster_profiles
  add constraint roaster_profiles_dominant_color_hex_check
  check (
    dominant_color_hex is null
    or dominant_color_hex ~ '^#[0-9A-F]{6}$'
  );

update public.roaster_profiles rp
set dominant_color_hex = cr.dominant_color_hex
from public.coffee_roasters cr
where cr.id = rp.coffee_roaster_id;

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
    dominant_color_hex,
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
    new.dominant_color_hex,
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
    dominant_color_hex      = new.dominant_color_hex,
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
      dominant_color_hex,
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

create table if not exists service.roaster_dominant_color_backfill (
  roaster_id bigint primary key references public.coffee_roasters(id),
  attempted_at timestamptz not null default now(),
  success boolean not null default false,
  error_message text
);

alter table service.roaster_dominant_color_backfill enable row level security;

drop policy if exists service_role_roaster_dominant_color_backfill
  on service.roaster_dominant_color_backfill;

create policy service_role_roaster_dominant_color_backfill
  on service.roaster_dominant_color_backfill
  for all
  to service_role
  using (true)
  with check (true);

create or replace function public.get_roasters_needing_dominant_color(
  batch_size int default 25
)
returns table (
  id bigint,
  roaster_name text,
  roaster_logo_mirror_url text
)
language sql
stable
as $$
  select
    cr.id,
    cr.roaster_name,
    cr.roaster_logo_mirror_url
  from public.coffee_roasters cr
  left join service.roaster_dominant_color_backfill rdc
    on rdc.roaster_id = cr.id
  where cr.dominant_color_hex is null
    and cr.roaster_logo_mirror_url is not null
    and rdc.roaster_id is null
  order by cr.id
  limit batch_size;
$$;

create or replace function public.record_roaster_dominant_color_backfill(
  p_roaster_id bigint,
  p_success boolean,
  p_error_message text default null
)
returns void
language plpgsql
as $$
begin
  insert into service.roaster_dominant_color_backfill (
    roaster_id,
    attempted_at,
    success,
    error_message
  )
  values (
    p_roaster_id,
    now(),
    p_success,
    p_error_message
  )
  on conflict (roaster_id)
  do update set
    attempted_at = now(),
    success = p_success,
    error_message = p_error_message;
end;
$$;

create or replace function public.enqueue_roaster_dominant_color_generation()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  project_url text := (
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'supabase_url'
  );
  edge_function_url text;
begin
  if project_url is null then
    raise exception 'Vault secret supabase_url is not set.';
  end if;

  edge_function_url := project_url || '/functions/v1/generate-roaster-dominant-color';

  perform net.http_post(
    edge_function_url,
    jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(new),
      'old_record', to_jsonb(old)
    ),
    '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json'),
    30000
  );

  return new;
end;
$$;

drop trigger if exists trg_generate_roaster_dominant_color on public.coffee_roasters;

create trigger trg_generate_roaster_dominant_color
  after update of roaster_logo_mirror_url on public.coffee_roasters
  for each row
  when (old.roaster_logo_mirror_url is distinct from new.roaster_logo_mirror_url)
  execute function public.enqueue_roaster_dominant_color_generation();
