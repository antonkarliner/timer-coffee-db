-- Extend review i18n: (1) cache a translated bean name alongside the translated
-- review text, and (2) surface canonical ISO origin codes on each review so the
-- client can render the origin in the viewer's locale (always), independent of
-- the language the reviewer typed it in.

-- Translated bean name lives in the same per-(review, locale) cache row as the
-- translated text. Nullable: a review may have a name but no translatable text,
-- or a name that is the same in the target language.
alter table public.bean_review_translations
  add column translated_bean_name text;

-- Invalidate cached translations when EITHER the review text or the bean name
-- changes (previously only review_text was watched). Re-issued in full.
create or replace function public.invalidate_bean_review_translations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.review_text is distinct from old.review_text
     or new.bean_name is distinct from old.bean_name then
    delete from public.bean_review_translations where review_id = old.id;
    if new.review_text is distinct from old.review_text then
      new.detected_source_locale := null;
    end if;
  end if;
  return new;
end;
$$;

-- Re-issue get_roaster_reviews to expose bean_origin_codes (canonical ISO codes
-- for the bean's origin, from the normalization cache). Raw bean_origin is kept
-- as a fallback for origins not yet normalized. Body otherwise matches the
-- definition in 20260509120000_bean_review_translations.sql.
create or replace function public.get_roaster_reviews(
  p_roaster_profile_id uuid,
  p_offset integer default 0,
  p_limit integer default 20
)
returns json
language sql
stable security definer
set search_path to 'public', 'pg_catalog'
as $function$
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
      br.detected_source_locale,
      br.created_at,
      br.updated_at,
      rr.reply_text,
      rr.created_at as reply_created_at,
      upp.display_name         as reviewer_display_name,
      upp.profile_picture_url  as reviewer_avatar_url,
      ucb.origin               as bean_origin,
      coalesce(n.country_codes, '{}'::text[]) as bean_origin_codes,
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
    left join public.bean_origin_normalizations n
           on n.origin_key = public.normalize_origin_key(ucb.origin)
    left join public.brewing_methods bm
           on bm.brewing_method_id = br.brewing_method_id
    where br.roaster_profile_id = p_roaster_profile_id
      and br.is_public = true
    order by br.created_at desc
    offset p_offset
    limit p_limit
  ) t;
$function$;

grant execute on function public.get_roaster_reviews(uuid, integer, integer)
  to anon, authenticated, service_role;
