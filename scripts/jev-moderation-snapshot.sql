-- Plan 034 moderation evaluation: real, presumed-benign text for a
-- false-positive check. READ-ONLY. Output is one JSON array of cases in the
-- jev-moderation-eval.ts shape; save it OUTSIDE the repo (it is user text)
-- and pass it with --cases FILE --allow-production-text.
--
-- expect = 'allow_presumed': this text is live, so it passed whatever
-- moderation existed when it was written (some predates the current chain).
-- That makes it biased in favour of the legacy pipeline: use it only to ask
-- "how often would a candidate newly block real content?", never for recall.
with reviews as (
  select 'prod-review-' || r.id::text as id, 'review' as surface,
         coalesce(r.detected_source_locale, 'unknown') as lang,
         r.review_text as text
  from public.bean_reviews r
  where coalesce(btrim(r.review_text), '') <> ''
),
names as (
  select 'prod-name-' || p.user_id::text as id, 'display_name' as surface,
         'unknown' as lang, p.display_name as text
  from public.user_public_profiles p
  where coalesce(btrim(p.display_name), '') <> ''
  order by md5(p.user_id::text)  -- stable pseudo-random sample
  limit 150
),
recipes as (
  -- Same text the app sends: name, short description, grind, then steps.
  select 'prod-recipe-' || l.id as id, 'recipe' as surface,
         coalesce(l.locale, 'unknown') as lang,
         btrim(concat_ws(E'\n', l.name, l.short_description, l.grind_size,
           (select string_agg(s.description, E'\n' order by s.step_order)
            from public.user_steps s
            where s.recipe_id = r.id and s.locale = l.locale))) as text
  from public.user_recipes r
  join public.user_recipe_localizations l on l.recipe_id = r.id
  where r.ispublic and not r.is_deleted
),
wishes as (
  select 'prod-wish-' || w.id::text as id, 'wish' as surface,
         coalesce(w.locale, 'unknown') as lang, w.text
  from public.yearly_wishes w
  where w.status = 'approved'
)
select json_agg(json_build_object(
  'id', id, 'surface', surface, 'lang', lang, 'expect', 'allow_presumed',
  'category', 'none', 'text', text, 'production', true) order by id)
from (
  select * from reviews union all select * from names
  union all select * from recipes union all select * from wishes
) t
where coalesce(text, '') <> '';
