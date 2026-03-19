-- Fix the notification trigger authentication issue
-- The existing launch popup trigger works without Authorization header, so we'll follow the same pattern

CREATE OR REPLACE FUNCTION public.translate_notification_after_insert()
RETURNS TRIGGER
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    project_url TEXT := (SELECT decrypted_secret FROM supabase_vault.decrypted_secrets WHERE name = 'supabase_url');
    edge_function_url TEXT;
    locales TEXT[];
BEGIN
    IF project_url IS NULL THEN
        RAISE EXCEPTION 'Vault secret ''supabase_url'' is not set';
    END IF;
    edge_function_url := project_url || '/functions/v1/translate-and-send-notification';

    -- Skip if this row is already translated
    IF NEW.is_translated THEN
        RETURN NEW;
    END IF;

    -- Only translate if the original notification is in English
    IF NEW.locale = 'en' THEN
        -- Gather target locales (exclude source 'en')
        SELECT array_agg(locale) INTO locales
        FROM supported_locales
        WHERE locale <> 'en';

        -- Call Edge function with translation request - no Authorization header like the launch popup function
        PERFORM net.http_post(
            edge_function_url,
            jsonb_build_object(
                'title', NEW.title,
                'content', NEW.content,
                'sourceLocale', NEW.locale,
                'locales', locales,
                'platform', NEW.platform,
                'deepLink', NEW.deep_link,
                'notificationId', NEW.id,
                'scheduledAt', NEW.scheduled_at,
                'notificationGroupId', NEW.notification_group_id
            ),
            '{}'::jsonb,
            jsonb_build_object('Content-Type', 'application/json'),
            300000
        );
    END IF;

    -- Actually update the original notification to mark as translated
    -- This is necessary because AFTER triggers don't automatically update the row
    UPDATE public.notifications 
    SET is_translated = true 
    WHERE id = NEW.id;

    RETURN NEW;
END;
$$;