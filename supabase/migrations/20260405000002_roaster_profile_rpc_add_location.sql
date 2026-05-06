-- Add state and address_text to get_roaster_profile RPC response.
-- These fields already exist on coffee_roasters; we just expose them.

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
      cr.state,
      cr.country,
      cr.address_text
    from public.roaster_profiles rp
    join public.coffee_roasters cr on cr.id = rp.coffee_roaster_id
    where rp.slug = p_slug
      and rp.is_active = true
    limit 1
  ) t;
$$;
