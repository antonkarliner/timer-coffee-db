-- Phase 4: connected apps propose page-detail changes; the roaster approves them.
--
-- A connected app (OAuth token with a client_id claim) can no longer change a
-- roaster profile directly. It writes a proposal; the roaster reviews it in the
-- dashboard, and approving it applies the change through the normal,
-- validated update path (update_my_roaster_profile, as the roaster).

-- 1. Which profile fields a proposal may carry. The page address (slug) is
--    deliberately absent: it stays with the roaster.
create or replace function public.roaster_profile_proposal_keys_valid(p_changes jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_changes) = 'object'
    and p_changes <> '{}'::jsonb
    and not exists (
      select 1
      from jsonb_object_keys(p_changes) as k(key)
      where k.key not in (
        'description', 'website_url', 'city', 'state', 'country', 'address_text',
        'instagram_url', 'twitter_url', 'facebook_url', 'tiktok_url'
      )
    );
$$;

-- 2. One pending proposal per roaster profile; new proposals merge into it.
create table public.roaster_profile_change_proposals (
  id uuid primary key default gen_random_uuid(),
  roaster_profile_id uuid not null unique references public.roaster_profiles (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  changes jsonb not null check (public.roaster_profile_proposal_keys_valid(changes)),
  client_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index roaster_profile_change_proposals_user_id_idx
  on public.roaster_profile_change_proposals (user_id);

alter table public.roaster_profile_change_proposals enable row level security;

revoke all on table public.roaster_profile_change_proposals from anon;
grant select, insert, update, delete on table public.roaster_profile_change_proposals to authenticated;

create policy roaster_profile_change_proposals_owner_select on public.roaster_profile_change_proposals
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy roaster_profile_change_proposals_owner_insert on public.roaster_profile_change_proposals
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.roaster_profiles rp
      where rp.id = roaster_profile_change_proposals.roaster_profile_id
        and rp.admin_user_id = (select auth.uid())
    )
  );

create policy roaster_profile_change_proposals_owner_update on public.roaster_profile_change_proposals
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.roaster_profiles rp
      where rp.id = roaster_profile_change_proposals.roaster_profile_id
        and rp.admin_user_id = (select auth.uid())
    )
  );

create policy roaster_profile_change_proposals_owner_delete on public.roaster_profile_change_proposals
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- client_id records which connected app last wrote the proposal (null when
-- the roaster's own session wrote it); callers cannot set it.
create or replace function public.stamp_roaster_profile_change_proposal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.client_id := nullif(auth.jwt() ->> 'client_id', '');
  new.updated_at := now();
  return new;
end;
$$;

create trigger stamp_roaster_profile_change_proposal
  before insert or update on public.roaster_profile_change_proposals
  for each row execute function public.stamp_roaster_profile_change_proposal();

-- 3. Connected apps can no longer change a profile directly (this replaces the
--    Phase 1 slug-only check). Body otherwise unchanged.
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
$function$;
