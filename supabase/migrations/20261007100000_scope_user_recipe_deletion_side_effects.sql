-- Recipe deletion/restoration previously changed every user's rows for a recipe.
-- Enforce user-owned recipe namespaces and scope trigger side effects to the owner.

alter table public.user_recipes
  add constraint user_recipes_vendor_id_user_namespace
  check (
    vendor_id is not null
    and vendor_id ~ '^usr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) not valid;

alter table public.user_recipes
  add constraint user_recipes_id_in_vendor_namespace
  check (
    length(id) > length(vendor_id) + 1
    and left(id, length(vendor_id) + 1) = vendor_id || '-'
  ) not valid;

alter table public.user_recipes
  validate constraint user_recipes_vendor_id_user_namespace;
alter table public.user_recipes
  validate constraint user_recipes_id_in_vendor_namespace;

create or replace function public.handle_user_recipe_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
    v_owner uuid;
begin
    if (
        NEW.vendor_id is not null
        and NEW.vendor_id ~ '^usr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and length(NEW.id) > length(NEW.vendor_id) + 1
        and left(NEW.id, length(NEW.vendor_id) + 1) = NEW.vendor_id || '-'
    ) is not true then
        return NEW;
    end if;

    v_owner := substr(NEW.vendor_id, 5)::uuid;

    IF NEW.is_deleted = TRUE AND (TG_OP = 'INSERT' OR OLD.is_deleted = FALSE) THEN
        UPDATE public.user_stats
        SET is_deleted = TRUE
        WHERE recipe_id = NEW.id AND user_id = v_owner;

        DELETE FROM public.user_recipe_preferences
        WHERE recipe_id = NEW.id AND user_id = v_owner;
    END IF;

    IF NEW.is_deleted = FALSE AND TG_OP = 'UPDATE' AND OLD.is_deleted = TRUE THEN
        UPDATE public.user_stats
        SET is_deleted = FALSE
        WHERE recipe_id = NEW.id AND user_id = v_owner;
    END IF;

    RETURN NEW;
end;
$function$;

revoke execute on function public.handle_user_recipe_deletion() from public;
revoke execute on function public.handle_user_recipe_deletion() from anon;
revoke execute on function public.handle_user_recipe_deletion() from authenticated;
grant  execute on function public.handle_user_recipe_deletion() to service_role;
grant  execute on function public.handle_user_recipe_deletion() to postgres;
