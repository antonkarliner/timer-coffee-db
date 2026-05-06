-- Allow roaster owners to edit the public slug for their assigned profile.

create or replace function public.normalize_roaster_profile_slug(p_value text)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select nullif(
    trim(both '-' from regexp_replace(
      regexp_replace(lower(extensions.unaccent(coalesce(trim(p_value), ''))), '[^a-z0-9]+', '-', 'g'),
      '-{2,}', '-', 'g'
    )),
    ''
  );
$$;

drop function if exists public.update_my_roaster_profile(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
);

create or replace function public.update_my_roaster_profile(
  p_slug text default null,
  p_description text default null,
  p_website_url text default null,
  p_city text default null,
  p_state text default null,
  p_country text default null,
  p_address_text text default null,
  p_instagram_url text default null,
  p_twitter_url text default null,
  p_facebook_url text default null,
  p_tiktok_url text default null
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_current_profile public.roaster_profiles;
  v_profile public.roaster_profiles;
  v_slug text;
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

  if exists (
    select 1
    from public.roaster_profiles rp
    where rp.slug = v_slug
      and rp.id <> v_current_profile.id
  ) then
    raise exception 'That slug is already in use';
  end if;

  update public.roaster_profiles
  set
    slug = v_slug,
    description = p_description,
    website_url = p_website_url,
    city = p_city,
    state = p_state,
    country = p_country,
    address_text = p_address_text,
    instagram_url = p_instagram_url,
    twitter_url = p_twitter_url,
    facebook_url = p_facebook_url,
    tiktok_url = p_tiktok_url,
    updated_at = now()
  where id = v_current_profile.id
  returning * into v_profile;

  return row_to_json(v_profile);
end;
$$;

grant execute on function public.update_my_roaster_profile(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text
) to authenticated;
