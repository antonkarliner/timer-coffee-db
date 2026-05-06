-- Roaster admin portal ownership, storage, and owner-safe RPCs.

create unique index if not exists roaster_profiles_active_admin_user_uidx
  on public.roaster_profiles (admin_user_id)
  where admin_user_id is not null and is_active = true;

insert into storage.buckets (id, name, public)
values ('roaster-logos', 'roaster-logos', true)
on conflict (id) do update
set public = excluded.public;

drop policy if exists "Roaster logos are publicly readable" on storage.objects;
create policy "Roaster logos are publicly readable"
  on storage.objects
  for select
  to public
  using (bucket_id = 'roaster-logos');

create or replace function public.get_my_roaster_profile()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select row_to_json(t)
  from (
    select
      id,
      slug,
      coffee_roaster_id,
      admin_user_id,
      roaster_name,
      aliases,
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
      is_active,
      created_at,
      updated_at
    from public.roaster_profiles
    where admin_user_id = auth.uid()
    order by updated_at desc
    limit 1
  ) t;
$$;

create or replace function public.update_my_roaster_profile(
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
set search_path = public
as $$
declare
  v_profile public.roaster_profiles;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.roaster_profiles
  set
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
  where admin_user_id = auth.uid()
  returning * into v_profile;

  if not found then
    raise exception 'No roaster profile assigned to current user';
  end if;

  return row_to_json(v_profile);
end;
$$;

create or replace function public.admin_lookup_assignable_user_by_email(
  p_email text
)
returns json
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    case
      when not public.is_admin() then null
      else (
        select row_to_json(t)
        from (
          select
            u.id as user_id,
            u.email,
            coalesce(
              (
                select i.provider
                from auth.identities i
                where i.user_id = u.id
                  and i.provider = 'email'
                order by i.last_sign_in_at desc nulls last, i.created_at desc
                limit 1
              ),
              (
                select i.provider
                from auth.identities i
                where i.user_id = u.id
                order by i.last_sign_in_at desc nulls last, i.created_at desc
                limit 1
              )
            ) as provider,
            exists(
              select 1
              from auth.identities i
              where i.user_id = u.id
                and i.provider = 'email'
                and coalesce(i.email, u.email) is not null
            ) as has_email_identity,
            u.last_sign_in_at,
            u.created_at
          from auth.users u
          where lower(u.email) = lower(trim(p_email))
          limit 1
        ) t
      )
    end;
$$;

create or replace function public.admin_search_roaster_profiles(
  p_query text default null,
  p_limit int default 15
)
returns table (
  id uuid,
  slug text,
  roaster_name text,
  aliases text,
  admin_user_id uuid,
  assigned_email text,
  is_active boolean,
  recipe_count bigint
)
language sql
stable
security definer
set search_path = public, auth, extensions
as $$
  select
    rp.id,
    rp.slug,
    rp.roaster_name,
    rp.aliases,
    rp.admin_user_id,
    u.email as assigned_email,
    rp.is_active,
    coalesce((
      select count(*)::bigint
      from public.user_recipes ur
      where rp.admin_user_id is not null
        and ur.vendor_id = 'usr-' || rp.admin_user_id::text
        and ur.ispublic = true
        and coalesce(ur.is_deleted, false) = false
    ), 0) as recipe_count
  from public.roaster_profiles rp
  left join auth.users u on u.id = rp.admin_user_id
  where public.is_admin()
    and (
      p_query is null
      or trim(p_query) = ''
      or lower(extensions.unaccent(rp.roaster_name)) like '%' || lower(extensions.unaccent(trim(p_query))) || '%'
      or lower(extensions.unaccent(coalesce(rp.aliases, ''))) like '%' || lower(extensions.unaccent(trim(p_query))) || '%'
      or lower(rp.slug) like '%' || lower(trim(p_query)) || '%'
    )
  order by
    rp.is_active desc,
    (rp.admin_user_id is not null) desc,
    rp.roaster_name asc
  limit greatest(1, least(coalesce(p_limit, 15), 30));
$$;

create or replace function public.admin_set_roaster_profile_owner(
  p_roaster_profile_id uuid,
  p_admin_user_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_profile public.roaster_profiles;
begin
  if not public.is_admin() then
    raise exception 'Admin privileges required';
  end if;

  if p_admin_user_id is not null and not exists (
    select 1
    from auth.identities i
    where i.user_id = p_admin_user_id
      and i.provider = 'email'
      and i.email is not null
  ) then
    raise exception 'Assigned owner must have a Supabase email identity';
  end if;

  update public.roaster_profiles
  set
    admin_user_id = p_admin_user_id,
    updated_at = now()
  where id = p_roaster_profile_id
  returning * into v_profile;

  if not found then
    raise exception 'Roaster profile not found';
  end if;

  return row_to_json(v_profile);
end;
$$;

grant execute on function public.get_my_roaster_profile() to authenticated;
grant execute on function public.update_my_roaster_profile(text, text, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.admin_lookup_assignable_user_by_email(text) to authenticated;
grant execute on function public.admin_search_roaster_profiles(text, int) to authenticated;
grant execute on function public.admin_set_roaster_profile_owner(uuid, uuid) to authenticated;
