-- Update database trigger to include security headers for system validation
-- This ensures the translate-and-send-notification Edge Function can validate
-- that calls are coming from the database trigger and not external sources

CREATE OR REPLACE FUNCTION public.translate_notification_after_insert()
RETURNS TRIGGER
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    project_url TEXT := (SELECT decrypted_secret FROM supabase_vault.decrypted_secrets WHERE name = 'supabase_url');
    edge_function_url TEXT;
    locales TEXT[];
    notification_group_id TEXT;
BEGIN
    IF project_url IS NULL THEN
        RAISE EXCEPTION 'Vault secret ''supabase_url'' is not set';
    END IF;
    edge_function_url := project_url || '/functions/v1/translate-and-send-notification';

    -- Skip if this row is already translated
    IF NEW.is_translated THEN
        RETURN NEW;
    END IF;

    -- Generate notification group ID if not present
    notification_group_id := COALESCE(NEW.notification_group_id, gen_random_uuid()::text);
    
    -- Update the notification with the group ID
    UPDATE public.notifications 
    SET notification_group_id = notification_group_id 
    WHERE id = NEW.id;

    -- Gather target locales (exclude source locale)
    SELECT array_agg(locale) INTO locales
    FROM supported_locales
    WHERE locale <> NEW.locale;

    -- Call Edge function with translation request and security header
    PERFORM net.http_post(
        url := edge_function_url,
        body := jsonb_build_object(
            'title', NEW.title,
            'content', NEW.content,
            'locales', locales,
            'platform', NEW.platform,
            'deep_link', NEW.deep_link,
            'scheduled_at', NEW.scheduled_at,
            'notification_group_id', notification_group_id
        ),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
            'X-System-Call', 'database-trigger'
        ),
        timeout_milliseconds := 300000
    );

    -- Mark as being processed
    RETURN NEW;
END;
$$;

-- Update cron job to include security headers
CREATE OR REPLACE FUNCTION public.process_scheduled_notifications_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
$$;

-- Update the cron job to use the new function
SELECT cron.unschedule('process-scheduled-notifications');

SELECT cron.schedule(
    'process-scheduled-notifications',
    '* * * * *',
    'SELECT public.process_scheduled_notifications_cron();'
);