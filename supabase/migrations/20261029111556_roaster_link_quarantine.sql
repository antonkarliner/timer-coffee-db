-- Phase 4: automatic link re-scan. When Google Web Risk flags a link on a
-- roaster page, the scan quarantines it: the value is moved out of the public
-- columns (so the website, the app and direct table reads all stop showing
-- it) into service.roaster_link_flags, which only admins can read. The roaster
-- sees what was flagged in the dashboard; saving the page details resolves it.

alter table public.roaster_profiles
  add column links_paused_at timestamptz,
  add column links_checked_at timestamptz;

comment on column public.roaster_profiles.links_paused_at is
  'Set when the link scan quarantined a flagged link; cleared when the roaster saves their page details.';
comment on column public.roaster_profiles.links_checked_at is
  'Last time the link scan looked this page up in Google Web Risk.';

-- 1. Flag records (admin-only). original_value holds the quarantined column
--    value so an admin can restore it if the flag was a false positive.
create table service.roaster_link_flags (
  id uuid primary key default gen_random_uuid(),
  roaster_profile_id uuid not null references public.roaster_profiles (id) on delete cascade,
  coffee_roaster_id bigint,
  field text not null check (field in ('website_url', 'description')),
  url text not null,
  original_value text,
  threat_types text[] not null default '{}',
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text check (resolution in ('roaster_saved', 'admin_restored', 'admin_dismissed'))
);

create index roaster_link_flags_open_idx
  on service.roaster_link_flags (roaster_profile_id)
  where resolved_at is null;

alter table service.roaster_link_flags enable row level security;

revoke all on table service.roaster_link_flags from anon, authenticated;
grant select, update on table service.roaster_link_flags to authenticated;

create policy roaster_link_flags_admin_select on service.roaster_link_flags
  for select to authenticated
  using ((select public.is_admin()));

create policy roaster_link_flags_admin_update on service.roaster_link_flags
  for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- 2. Quarantine one flagged link (called by the scan with the service role).
--    Returns the flag id, or null if the value already changed since the scan
--    read it (nothing is quarantined then).
create or replace function service.quarantine_roaster_link(
  p_roaster_profile_id uuid,
  p_field text,
  p_url text,
  p_threat_types text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.roaster_profiles;
  v_original text;
  v_flag_id uuid;
begin
  if p_field not in ('website_url', 'description') then
    raise exception 'Unsupported field %', p_field using errcode = '22023';
  end if;

  select * into v_profile
  from public.roaster_profiles
  where id = p_roaster_profile_id
  for update;

  if not found then
    return null;
  end if;

  v_original := case p_field
    when 'website_url' then v_profile.website_url
    else v_profile.description
  end;

  -- The page changed after the scan read it: let the next scan decide.
  if v_original is null
     or (p_field = 'website_url' and v_original <> p_url)
     or (p_field = 'description' and position(p_url in v_original) = 0) then
    return null;
  end if;

  insert into service.roaster_link_flags
    (roaster_profile_id, coffee_roaster_id, field, url, original_value, threat_types)
  values
    (v_profile.id, v_profile.coffee_roaster_id, p_field, p_url, v_original, coalesce(p_threat_types, '{}'))
  returning id into v_flag_id;

  if p_field = 'website_url' then
    -- coffee_roasters is the source the profile syncs from (and is public too),
    -- so the quarantine must clear it as well or the link would come back.
    update public.coffee_roasters
    set roaster_website_url = null
    where id = v_profile.coffee_roaster_id
      and roaster_website_url = p_url;

    update public.roaster_profiles
    set website_url = null, links_paused_at = now()
    where id = v_profile.id;
  else
    update public.roaster_profiles
    set description = null, links_paused_at = now()
    where id = v_profile.id;
  end if;

  return v_flag_id;
end;
$$;

revoke all on function service.quarantine_roaster_link(uuid, text, text, text[]) from public, anon, authenticated;
grant execute on function service.quarantine_roaster_link(uuid, text, text, text[]) to service_role;

-- 3. Which pages the scan checks next: roaster-managed pages and pages changed
--    in the last 7 days every day; everything else when its last check is a
--    week old (a rolling weekly scan). Only active pages with a website or a
--    link in the description.
create or replace function service.roaster_link_scan_batch(p_limit integer)
returns table (
  roaster_profile_id uuid,
  website_url text,
  description text,
  admin_user_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select rp.id, rp.website_url, rp.description, rp.admin_user_id
  from public.roaster_profiles rp
  where rp.is_active
    and (rp.website_url is not null or rp.description ~* '(https?://|www\.)')
    and (
      rp.links_checked_at is null
      or rp.links_checked_at < now() - interval '7 days'
      or (
        (rp.admin_user_id is not null or rp.updated_at > now() - interval '7 days')
        and rp.links_checked_at < now() - interval '20 hours'
      )
    )
  order by
    (rp.admin_user_id is not null) desc,
    (rp.updated_at > now() - interval '7 days') desc,
    rp.links_checked_at asc nulls first
  limit greatest(1, least(p_limit, 1000));
$$;

revoke all on function service.roaster_link_scan_batch(integer) from public, anon, authenticated;
grant execute on function service.roaster_link_scan_batch(integer) to service_role;

create or replace function service.mark_roaster_links_checked(p_roaster_profile_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.roaster_profiles
  set links_checked_at = now()
  where id = any (p_roaster_profile_ids);
$$;

revoke all on function service.mark_roaster_links_checked(uuid[]) from public, anon, authenticated;
grant execute on function service.mark_roaster_links_checked(uuid[]) to service_role;

-- 4. What the roaster sees in their dashboard: their open flags (their own
--    page's data, including the flagged URL so they know what to fix).
create or replace function public.get_my_roaster_link_flags()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(json_agg(json_build_object(
    'field', f.field,
    'url', f.url,
    'threat_types', f.threat_types,
    'detected_at', f.detected_at
  ) order by f.detected_at desc), '[]'::json)
  from service.roaster_link_flags f
  join public.roaster_profiles rp on rp.id = f.roaster_profile_id
  where rp.admin_user_id = (select auth.uid())
    and f.resolved_at is null
    and not (select public.is_oauth_client_request());
$$;

revoke all on function public.get_my_roaster_link_flags() from public, anon;
grant execute on function public.get_my_roaster_link_flags() to authenticated;

-- 5. Saving page details resolves the roaster's open flags and lifts the
--    pause, but a URL that is currently flagged can't be saved again (even if
--    the website's own Web Risk lookup failed open). Body otherwise unchanged.
CREATE OR REPLACE FUNCTION public.update_my_roaster_profile(p_slug text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_website_url text DEFAULT NULL::text, p_city text DEFAULT NULL::text, p_state text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_address_text text DEFAULT NULL::text, p_instagram_url text DEFAULT NULL::text, p_twitter_url text DEFAULT NULL::text, p_facebook_url text DEFAULT NULL::text, p_tiktok_url text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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

  -- Phase 4: connected apps propose changes instead of applying them.
  if public.is_oauth_client_request() then
    raise exception
      'Connected apps cannot change page details directly. Save a proposal for the roaster to approve.'
      using errcode = '42501';
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

  -- Phase 4: a link the safety scan flagged can't be saved back.
  if exists (
    select 1
    from service.roaster_link_flags f
    where f.roaster_profile_id = v_current_profile.id
      and f.resolved_at is null
      and (
        f.url = v_website_url
        or (p_description is not null and position(f.url in p_description) > 0)
      )
  ) then
    raise exception
      'That link was flagged as unsafe by Google Web Risk. Use a different link.'
      using errcode = '22023';
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
    links_paused_at = null,
    updated_at = now()
  where id = v_current_profile.id
  returning * into v_profile;

  update service.roaster_link_flags
  set resolved_at = now(), resolution = 'roaster_saved'
  where roaster_profile_id = v_current_profile.id
    and resolved_at is null;

  return row_to_json(v_profile);
end;
$function$;
