drop trigger if exists "translate_notification_after_insert_trigger" on "public"."notifications";

drop trigger if exists "update_notifications_updated_at" on "public"."notifications";

drop policy "Authenticated read access" on "public"."notifications";

drop policy "Service role full access" on "public"."notifications";

alter table "public"."notifications" drop constraint "notifications_locale_fkey";

alter table "public"."notifications" drop constraint "notifications_platform_check";

drop function if exists "public"."get_grouped_scheduled_notifications"();

drop function if exists "public"."process_scheduled_notifications"();

drop function if exists "public"."update_updated_at_column"();

drop index if exists "public"."idx_notifications_locale";

drop index if exists "public"."idx_notifications_scheduled_at";

alter table "public"."notifications" add column "notification_group_id" uuid default gen_random_uuid();

alter table "public"."notifications" add column "title" text not null;

alter table "public"."notifications" alter column "created_at" set not null;

alter table "public"."notifications" alter column "is_sent" set not null;

alter table "public"."notifications" alter column "is_translated" set not null;

alter table "public"."notifications" alter column "locale" set default 'en'::text;

alter table "public"."notifications" alter column "locale" set data type text using "locale"::text;

alter table "public"."notifications" alter column "platform" set not null;

alter table "public"."notifications" alter column "scheduled_at" set default now();

alter table "public"."notifications" alter column "updated_at" set not null;

CREATE INDEX idx_notifications_group_id ON public.notifications USING btree (notification_group_id);

CREATE INDEX idx_notifications_scheduled_at ON public.notifications USING btree (scheduled_at);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.handle_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_user_recipe_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    -- Handle deletion (is_deleted = TRUE)
    IF NEW.is_deleted = TRUE AND (TG_OP = 'INSERT' OR OLD.is_deleted = FALSE) THEN
        -- Update user_stats: set is_deleted to TRUE for matching recipe_id
        UPDATE public.user_stats
        SET is_deleted = TRUE
        WHERE recipe_id = NEW.id;
        
        -- Delete from user_recipe_preferences for matching recipe_id
        -- Note: This table has no FK constraint, so we handle it manually
        DELETE FROM public.user_recipe_preferences
        WHERE recipe_id = NEW.id;
        
        -- Note: user_recipe_localizations and user_steps will be handled
        -- automatically by CASCADE DELETE when the recipe is actually deleted
    END IF;
    
    -- Handle restoration (is_deleted = FALSE)
    IF NEW.is_deleted = FALSE AND TG_OP = 'UPDATE' AND OLD.is_deleted = TRUE THEN
        -- Update user_stats: set is_deleted to FALSE for matching recipe_id
        UPDATE public.user_stats
        SET is_deleted = FALSE
        WHERE recipe_id = NEW.id;
        
        -- Note: user_recipe_preferences rows cannot be restored once deleted
        -- user_recipe_localizations and user_steps would need to be restored
        -- if they were actually deleted (but they're only deleted on CASCADE)
    END IF;
    
    RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.process_scheduled_notifications_cron()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    project_url TEXT := (SELECT decrypted_secret FROM supabase_vault.decrypted_secrets WHERE name = 'supabase_url');
    edge_function_url TEXT;
    cron_secret TEXT := current_setting('app.settings.cron_job_secret', true);
BEGIN
    IF project_url IS NULL THEN
        RAISE EXCEPTION 'Vault secret ''supabase_url'' is not set';
    END IF;
    edge_function_url := project_url || '/functions/v1/process-scheduled-notifications';

    -- Call Edge function with cron job security header
    PERFORM net.http_post(
        url := edge_function_url,
        body := jsonb_build_object('timestamp', now()),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
            'X-System-Token', cron_secret
        ),
        timeout_milliseconds := 300000
    );
END;
$function$
;

grant select on table "public"."notifications" to "cline_mcp_readonly_role";

create policy "Allow insert for authenticated users"
on "public"."notifications"
as permissive
for insert
to public
with check ((auth.role() = 'authenticated'::text));


create policy "Enable read access for authenticated users"
on "public"."notifications"
as permissive
for select
to public
using ((auth.role() = 'authenticated'::text));


create policy "Service role can manage notifications"
on "public"."notifications"
as permissive
for all
to public
using ((auth.role() = 'service_role'::text))
with check ((auth.role() = 'service_role'::text));


CREATE TRIGGER handle_notifications_updated_at BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION handle_updated_at();

CREATE TRIGGER translate_notification_after_insert AFTER INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION translate_notification_after_insert();

CREATE TRIGGER trigger_user_recipe_insert_deletion AFTER INSERT ON public.user_recipes FOR EACH ROW WHEN ((new.is_deleted = true)) EXECUTE FUNCTION handle_user_recipe_deletion();

CREATE TRIGGER trigger_user_recipe_update_deletion AFTER UPDATE ON public.user_recipes FOR EACH ROW WHEN ((new.is_deleted <> old.is_deleted)) EXECUTE FUNCTION handle_user_recipe_deletion();


