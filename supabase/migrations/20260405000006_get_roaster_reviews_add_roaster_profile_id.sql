-- Fix: get_roaster_reviews was missing roaster_profile_id in SELECT.
-- This caused BeanReviewModel.roasterProfileId to always be '' in the app,
-- so _invalidateCacheForRoaster keyed on '' instead of the real ID,
-- leaving the UI stale after delete/update.

CREATE OR REPLACE FUNCTION public.get_roaster_reviews(p_roaster_profile_id uuid, p_offset integer DEFAULT 0, p_limit integer DEFAULT 20)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  select json_agg(t)
  from (
    select
      br.id,
      br.user_id,
      br.roaster_profile_id,
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
$function$;
