-- Expose `aliases` from get_roaster_profile so the client can match a user's
-- free-text bean roaster string (which may be spelled as an alias) against this
-- roaster when gating the "Write a Review" button and filtering the review
-- form's bean selector. Mirrors the alias-aware logic already used server-side
-- by resolve_roaster_profile_for_review and the bag-count attachment.
--
-- Identical to the definition shipped in 20260628200000_roaster_bag_counts.sql
-- plus the `aliases` field. logged_bag_count preserved verbatim.

create or replace function public.get_roaster_profile(p_slug text)
returns json
language sql
stable
security definer
set search_path = public, extensions, pg_catalog
as $function$
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
      coalesce((
        select count(*)
        from public.global_coffee_beans g
        where g.coffee_roaster_id = roaster_profiles.coffee_roaster_id
      ), 0) as logged_bag_count
    from public.roaster_profiles
    where slug = p_slug
      and is_active = true
    limit 1
  ) t;
$function$;
