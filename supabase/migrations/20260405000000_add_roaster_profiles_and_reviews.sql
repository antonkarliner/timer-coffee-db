-- Roaster profile pages: roaster_profiles, bean_reviews, review_replies
--
-- Architecture:
--   roaster_profiles bridges coffee_roasters (logo/name/location) with a
--   verified admin user whose user_recipes appear on the profile page.
--
--   bean_reviews are per-bean reviews that aggregate on the roaster page.
--   review_replies allow the roaster admin to reply once per review.

-- ─── roaster_profiles ────────────────────────────────────────────────────────

create table public.roaster_profiles (
  id                uuid primary key default gen_random_uuid(),
  coffee_roaster_id bigint not null references public.coffee_roasters(id),
  admin_user_id     uuid references auth.users(id),
  slug              text unique not null,
  description       text,
  instagram_url     text,
  twitter_url       text,
  facebook_url      text,
  tiktok_url        text,
  is_active         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index on public.roaster_profiles (coffee_roaster_id);
create index on public.roaster_profiles (admin_user_id);

alter table public.roaster_profiles enable row level security;

-- Public read for active profiles
create policy "roaster_profiles_public_read"
  on public.roaster_profiles
  for select
  using (is_active = true);

-- Only service role can write (web dashboard / admin)
create policy "roaster_profiles_service_role_manage"
  on public.roaster_profiles
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- ─── bean_reviews ─────────────────────────────────────────────────────────────

create table public.bean_reviews (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id),
  roaster_profile_id  uuid not null references public.roaster_profiles(id),
  bean_name           text not null,
  coffee_beans_uuid   text,                              -- private link to author's local bean
  rating              real not null check (rating >= 1 and rating <= 5),
  review_text         text,
  sweetness           real check (sweetness >= 0 and sweetness <= 1),
  acidity             real check (acidity >= 0 and acidity <= 1),
  fruitiness          real check (fruitiness >= 0 and fruitiness <= 1),
  body                real check (body >= 0 and body <= 1),
  is_public           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, roaster_profile_id, bean_name)
);

create index on public.bean_reviews (roaster_profile_id);
create index on public.bean_reviews (user_id);

alter table public.bean_reviews enable row level security;

-- Anyone can read public reviews
create policy "bean_reviews_public_read"
  on public.bean_reviews
  for select
  using (is_public = true);

-- Authenticated users can insert reviews
create policy "bean_reviews_authenticated_insert"
  on public.bean_reviews
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Users can update/delete only their own reviews
create policy "bean_reviews_own_update"
  on public.bean_reviews
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "bean_reviews_own_delete"
  on public.bean_reviews
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- ─── review_replies ───────────────────────────────────────────────────────────

create table public.review_replies (
  id          uuid primary key default gen_random_uuid(),
  review_id   uuid not null references public.bean_reviews(id) on delete cascade,
  user_id     uuid not null references auth.users(id),
  reply_text  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (review_id)                                      -- one reply per review
);

create index on public.review_replies (review_id);

alter table public.review_replies enable row level security;

-- Anyone can read replies
create policy "review_replies_public_read"
  on public.review_replies
  for select
  using (true);

-- Only the roaster admin for this review's roaster can insert
create policy "review_replies_roaster_admin_insert"
  on public.review_replies
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.bean_reviews br
      join public.roaster_profiles rp on rp.id = br.roaster_profile_id
      where br.id = review_id
        and rp.admin_user_id = auth.uid()
    )
  );

-- Roaster admin can update/delete their own reply
create policy "review_replies_own_update"
  on public.review_replies
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "review_replies_own_delete"
  on public.review_replies
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- ─── SQL functions ────────────────────────────────────────────────────────────

-- Fetch active roaster profile by slug, joining coffee_roasters for logo/location data
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
      cr.roaster_logo_url,
      cr.roaster_logo_mirror_url,
      cr.roaster_website_url,
      cr.city,
      cr.country
    from public.roaster_profiles rp
    join public.coffee_roasters cr on cr.id = rp.coffee_roaster_id
    where rp.slug = p_slug
      and rp.is_active = true
    limit 1
  ) t;
$$;

-- Find an active roaster profile by roaster name (for linking from bean detail)
-- Uses unaccent-normalised matching via normalized_name column
create or replace function public.get_roaster_profile_by_name(p_roaster_name text)
returns json
language sql
stable
security definer
as $$
  select row_to_json(t)
  from (
    select rp.id, rp.slug
    from public.roaster_profiles rp
    join public.coffee_roasters cr on cr.id = rp.coffee_roaster_id
    where rp.is_active = true
      and (
        lower(extensions.unaccent(cr.roaster_name)) = lower(extensions.unaccent(p_roaster_name))
        or lower(extensions.unaccent(coalesce(cr.normalized_name, ''))) = lower(extensions.unaccent(p_roaster_name))
        or lower(extensions.unaccent(coalesce(cr.aliases, ''))) ilike '%' || lower(extensions.unaccent(p_roaster_name)) || '%'
      )
    limit 1
  ) t;
$$;

-- Fetch paginated reviews for a roaster, including any reply
create or replace function public.get_roaster_reviews(
  p_roaster_profile_id uuid,
  p_offset             int default 0,
  p_limit              int default 20
)
returns json
language sql
stable
security definer
as $$
  select json_agg(t)
  from (
    select
      br.id,
      br.user_id,
      br.bean_name,
      br.rating,
      br.review_text,
      br.sweetness,
      br.acidity,
      br.fruitiness,
      br.body,
      br.created_at,
      br.updated_at,
      -- include reply if any
      rr.reply_text,
      rr.created_at as reply_created_at,
      -- public display name from user_public_profiles
      upp.display_name as reviewer_display_name,
      upp.profile_picture_url as reviewer_avatar_url
    from public.bean_reviews br
    left join public.review_replies rr on rr.review_id = br.id
    left join public.user_public_profiles upp on upp.user_id = br.user_id
    where br.roaster_profile_id = p_roaster_profile_id
      and br.is_public = true
    order by br.created_at desc
    offset p_offset
    limit p_limit
  ) t;
$$;

-- Aggregate rating summary for a roaster
create or replace function public.get_roaster_rating_summary(p_roaster_profile_id uuid)
returns json
language sql
stable
security definer
as $$
  select row_to_json(t)
  from (
    select
      round(avg(rating)::numeric, 1) as avg_rating,
      count(*)                        as review_count
    from public.bean_reviews
    where roaster_profile_id = p_roaster_profile_id
      and is_public = true
  ) t;
$$;

-- Fetch public recipes for a roaster admin user (joined with localizations/steps)
-- Returns recipe metadata; the app fetches full steps via existing providers.
create or replace function public.get_roaster_recipes(
  p_admin_user_id uuid,
  p_locale        text default 'en'
)
returns json
language sql
stable
security definer
as $$
  select json_agg(t)
  from (
    select
      ur.id,
      ur.brewing_method_id,
      ur.coffee_amount,
      ur.water_amount,
      ur.water_temp,
      ur.brew_time,
      ur.ispublic as is_public,
      coalesce(
        (select url_locale.name
         from public.user_recipe_localizations url_locale
         where url_locale.recipe_id = ur.id and url_locale.locale = p_locale
         limit 1),
        (select url_en.name
         from public.user_recipe_localizations url_en
         where url_en.recipe_id = ur.id and url_en.locale = 'en'
         limit 1)
      ) as name,
      coalesce(
        (select url_locale.grind_size
         from public.user_recipe_localizations url_locale
         where url_locale.recipe_id = ur.id and url_locale.locale = p_locale
         limit 1),
        (select url_en.grind_size
         from public.user_recipe_localizations url_en
         where url_en.recipe_id = ur.id and url_en.locale = 'en'
         limit 1)
      ) as grind_size,
      coalesce(
        (select url_locale.short_description
         from public.user_recipe_localizations url_locale
         where url_locale.recipe_id = ur.id and url_locale.locale = p_locale
         limit 1),
        (select url_en.short_description
         from public.user_recipe_localizations url_en
         where url_en.recipe_id = ur.id and url_en.locale = 'en'
         limit 1)
      ) as short_description
    from public.user_recipes ur
    where ur.vendor_id = 'usr-' || p_admin_user_id::text
      and ur.ispublic = true
      and (ur.is_deleted is null or ur.is_deleted = false)
    order by ur.last_modified desc
  ) t;
$$;
