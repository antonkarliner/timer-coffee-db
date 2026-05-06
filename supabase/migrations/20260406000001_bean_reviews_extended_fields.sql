-- Add new review fields: brew method, buy-again, flavor tags, bitterness, aftertaste.
-- fruitiness kept for backwards-compat reading of old reviews.

ALTER TABLE public.bean_reviews
  ADD COLUMN IF NOT EXISTS brewing_method_id TEXT,
  ADD COLUMN IF NOT EXISTS would_buy_again    BOOLEAN,
  ADD COLUMN IF NOT EXISTS flavor_tags        TEXT[],
  ADD COLUMN IF NOT EXISTS bitterness         FLOAT,
  ADD COLUMN IF NOT EXISTS aftertaste         FLOAT;

-- Update get_roaster_reviews to include new columns + joined brewing method name.
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
      br.brewing_method_id,
      br.would_buy_again,
      br.flavor_tags,
      br.bitterness,
      br.aftertaste,
      br.created_at,
      br.updated_at,
      rr.reply_text,
      rr.created_at as reply_created_at,
      upp.display_name         as reviewer_display_name,
      upp.profile_picture_url  as reviewer_avatar_url,
      ucb.origin               as bean_origin,
      ucb.roast_date           as bean_roast_date,
      bm.brewing_method        as brewing_method_name
    from public.bean_reviews br
    left join public.review_replies rr
           on rr.review_id = br.id
    left join public.user_public_profiles upp
           on upp.user_id = br.user_id
    left join public.user_coffee_beans ucb
           on ucb.beans_uuid = br.coffee_beans_uuid
          and ucb.user_id    = br.user_id
    left join public.brewing_methods bm
           on bm.brewing_method_id = br.brewing_method_id
    where br.roaster_profile_id = p_roaster_profile_id
      and br.is_public = true
    order by br.created_at desc
    offset p_offset
    limit p_limit
  ) t;
$function$;
