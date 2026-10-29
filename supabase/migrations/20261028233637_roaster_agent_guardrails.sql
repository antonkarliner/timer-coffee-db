-- Phase 1: guardrails for connected apps (AI agents) on the roaster-admin surface.
--
-- Supabase OAuth 2.1 access tokens carry a `client_id` claim; direct user
-- sessions (website, mobile and web apps) do not. These rules only ever
-- restrict requests that carry `client_id`, so existing clients are unaffected.

create or replace function public.is_oauth_client_request()
returns boolean
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'client_id', '') is not null;
$$;

comment on function public.is_oauth_client_request() is
  'True when the request uses an OAuth 2.1 access token issued to a connected app (JWT has client_id).';

-- 1. Connected apps never get admin rights, even on an admin's account.
--    Every service-schema policy and admin RPC goes through is_admin().
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'service', 'public', 'auth'
AS $function$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN TRUE;
  END IF;

  IF public.is_oauth_client_request() THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM service.admin_users au
    WHERE au.user_id = auth.uid()
      AND COALESCE(au.role, 'admin') IN ('admin', 'super_admin')
  );
END;
$function$;

-- 2. Public review replies: only the roaster's own session may publish,
--    edit or remove one. Connected apps write drafts instead (3).
create policy review_replies_no_connected_app_insert on public.review_replies
  as restrictive for insert to public
  with check (not (select public.is_oauth_client_request()));

create policy review_replies_no_connected_app_update on public.review_replies
  as restrictive for update to public
  using (not (select public.is_oauth_client_request()))
  with check (not (select public.is_oauth_client_request()));

create policy review_replies_no_connected_app_delete on public.review_replies
  as restrictive for delete to public
  using (not (select public.is_oauth_client_request()));

-- 3. Reply drafts: one pending draft per review, approved or discarded from
--    the roaster dashboard. client_id records which connected app wrote it
--    (null when written from the roaster's own session).
create table public.review_reply_drafts (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null unique references public.bean_reviews (id) on delete cascade,
  roaster_profile_id uuid not null references public.roaster_profiles (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reply_text text not null check (char_length(btrim(reply_text)) between 1 and 1500),
  client_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index review_reply_drafts_roaster_profile_id_idx
  on public.review_reply_drafts (roaster_profile_id);
create index review_reply_drafts_user_id_idx
  on public.review_reply_drafts (user_id);

alter table public.review_reply_drafts enable row level security;

revoke all on table public.review_reply_drafts from anon;
grant select, insert, update, delete on table public.review_reply_drafts to authenticated;

create policy review_reply_drafts_owner_select on public.review_reply_drafts
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy review_reply_drafts_owner_insert on public.review_reply_drafts
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.bean_reviews br
      join public.roaster_profiles rp on rp.id = br.roaster_profile_id
      where br.id = review_reply_drafts.review_id
        and rp.id = review_reply_drafts.roaster_profile_id
        and rp.admin_user_id = (select auth.uid())
    )
  );

create policy review_reply_drafts_owner_update on public.review_reply_drafts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.bean_reviews br
      join public.roaster_profiles rp on rp.id = br.roaster_profile_id
      where br.id = review_reply_drafts.review_id
        and rp.id = review_reply_drafts.roaster_profile_id
        and rp.admin_user_id = (select auth.uid())
    )
  );

create policy review_reply_drafts_owner_delete on public.review_reply_drafts
  for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.stamp_review_reply_draft()
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

create trigger stamp_review_reply_draft
  before insert or update on public.review_reply_drafts
  for each row execute function public.stamp_review_reply_draft();

-- 4. Profile: connected apps may edit page details but not the page address
--    (a slug change moves the public URL). Body unchanged apart from the
--    marked check.
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

  -- Phase 1: connected apps cannot move the public page.
  if public.is_oauth_client_request() and v_slug is distinct from v_current_profile.slug then
    raise exception
      'Connected apps cannot change the page address. Change it from the roaster dashboard.'
      using errcode = '42501';
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

-- 5. Recipes: connected apps may create and edit private recipes only.
--    Publishing, and any change to a published recipe, needs the roaster.
create policy user_recipes_connected_app_private_only_insert on public.user_recipes
  as restrictive for insert to public
  with check (not (select public.is_oauth_client_request()) or ispublic = false);

create policy user_recipes_connected_app_private_only_update on public.user_recipes
  as restrictive for update to public
  using (not (select public.is_oauth_client_request()) or ispublic = false)
  with check (not (select public.is_oauth_client_request()) or ispublic = false);

create policy user_recipes_connected_app_private_only_delete on public.user_recipes
  as restrictive for delete to public
  using (not (select public.is_oauth_client_request()) or ispublic = false);

create policy user_recipe_localizations_connected_app_private_only_insert on public.user_recipe_localizations
  as restrictive for insert to public
  with check (
    not (select public.is_oauth_client_request())
    or exists (select 1 from public.user_recipes r where r.id = user_recipe_localizations.recipe_id and r.ispublic = false)
  );

create policy user_recipe_localizations_connected_app_private_only_update on public.user_recipe_localizations
  as restrictive for update to public
  using (
    not (select public.is_oauth_client_request())
    or exists (select 1 from public.user_recipes r where r.id = user_recipe_localizations.recipe_id and r.ispublic = false)
  )
  with check (
    not (select public.is_oauth_client_request())
    or exists (select 1 from public.user_recipes r where r.id = user_recipe_localizations.recipe_id and r.ispublic = false)
  );

create policy user_recipe_localizations_connected_app_private_only_delete on public.user_recipe_localizations
  as restrictive for delete to public
  using (
    not (select public.is_oauth_client_request())
    or exists (select 1 from public.user_recipes r where r.id = user_recipe_localizations.recipe_id and r.ispublic = false)
  );

create policy user_steps_connected_app_private_only_insert on public.user_steps
  as restrictive for insert to public
  with check (
    not (select public.is_oauth_client_request())
    or exists (select 1 from public.user_recipes r where r.id = user_steps.recipe_id and r.ispublic = false)
  );

create policy user_steps_connected_app_private_only_update on public.user_steps
  as restrictive for update to public
  using (
    not (select public.is_oauth_client_request())
    or exists (select 1 from public.user_recipes r where r.id = user_steps.recipe_id and r.ispublic = false)
  )
  with check (
    not (select public.is_oauth_client_request())
    or exists (select 1 from public.user_recipes r where r.id = user_steps.recipe_id and r.ispublic = false)
  );

create policy user_steps_connected_app_private_only_delete on public.user_steps
  as restrictive for delete to public
  using (
    not (select public.is_oauth_client_request())
    or exists (select 1 from public.user_recipes r where r.id = user_steps.recipe_id and r.ispublic = false)
  );
