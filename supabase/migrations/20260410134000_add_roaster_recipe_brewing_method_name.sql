-- Return localized brewing method names for public roaster recipe cards.
CREATE OR REPLACE FUNCTION public.get_roaster_recipes(
  p_admin_user_id uuid,
  p_locale        text DEFAULT 'en'
)
RETURNS json
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $function$
  select json_agg(t)
  from (
    select
      ur.id,
      ur.brewing_method_id,
      bm.brewing_method as brewing_method_name,
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
    left join public.brewing_methods bm
           on bm.brewing_method_id = ur.brewing_method_id
    where ur.vendor_id = 'usr-' || p_admin_user_id::text
      and ur.ispublic = true
      and (ur.is_deleted is null or ur.is_deleted = false)
    order by ur.last_modified desc
  ) t;
$function$;
