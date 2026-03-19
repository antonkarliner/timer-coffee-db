-- Create translation function for notifications
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

    -- Gather target locales (exclude source locale)
    SELECT array_agg(locale) INTO locales
    FROM supported_locales
    WHERE locale <> NEW.locale;

    -- Call Edge function with translation request
    PERFORM net.http_post(
        url := edge_function_url,
        body := jsonb_build_object(
            'text', NEW.content,
            'sourceLocale', NEW.locale,
            'platform', NEW.platform,
            'deepLink', NEW.deep_link,
            'notificationId', NEW.id
        ),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
        ),
        timeout_milliseconds := 300000
    );

    -- Mark as being processed
    RETURN NEW;
END;
$$;

-- Create trigger for automatic translation
CREATE TRIGGER translate_notification_after_insert_trigger
AFTER INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.translate_notification_after_insert();