-- Enforce 1 review per bean record.
-- When a review is linked to a specific bean (coffee_beans_uuid NOT NULL),
-- a user may only have one review for that bean.
CREATE UNIQUE INDEX bean_reviews_user_bean_unique
  ON public.bean_reviews(user_id, coffee_beans_uuid)
  WHERE coffee_beans_uuid IS NOT NULL;

-- Update get_roaster_reviews to include origin + roast_date from the
-- reviewer's own bean record (user_coffee_beans), joined on
-- coffee_beans_uuid + user_id so we never expose another user's data.
CREATE OR REPLACE FUNCTION public.get_roaster_reviews(
  p_roaster_profile_id uuid,
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 20
)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER AS $function$
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
      upp.display_name    as reviewer_display_name,
      upp.profile_picture_url as reviewer_avatar_url,
      -- origin + roast date from the reviewer's own bean record
      ucb.origin          as bean_origin,
      ucb.roast_date      as bean_roast_date
    from public.bean_reviews br
    left join public.review_replies rr
           on rr.review_id = br.id
    left join public.user_public_profiles upp
           on upp.user_id = br.user_id
    left join public.user_coffee_beans ucb
           on ucb.beans_uuid = br.coffee_beans_uuid
          and ucb.user_id    = br.user_id
    where br.roaster_profile_id = p_roaster_profile_id
      and br.is_public = true
    order by br.created_at desc
    offset p_offset
    limit p_limit
  ) t;
$function$;
