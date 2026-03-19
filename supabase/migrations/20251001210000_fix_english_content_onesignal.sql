-- Fix OneSignal English content requirement
-- This migration ensures English content is always present in OneSignal payloads

-- Update process_and_send_scheduled_notifications to ensure English content
CREATE OR REPLACE FUNCTION public.process_and_send_scheduled_notifications()
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    notification_group RECORD;
    localized_contents JSONB;
    notification_ids BIGINT[];
    one_signal_response TEXT;
    job_start_time TIMESTAMPTZ := NOW();
    processed_count INTEGER := 0;
BEGIN
    -- Log job start
    RAISE LOG 'Starting scheduled notifications processing at %', job_start_time;
    
    -- Get all groups of notifications that are ready to be sent
    FOR notification_group IN 
        SELECT 
            scheduled_at,
            jsonb_agg(
                jsonb_build_object(
                    'id', id,
                    'content', content,
                    'locale', locale
                )
            ) as notifications,
            platform,
            deep_link,
            array_agg(id) as ids
        FROM public.notifications
        WHERE scheduled_at <= NOW()
        AND is_sent = FALSE
        AND is_translated = TRUE
        GROUP BY scheduled_at, platform, deep_link
        ORDER BY scheduled_at
        LIMIT 50  -- Process max 50 groups per run to prevent long-running jobs
    LOOP
        BEGIN
            -- Build localized content object
            localized_contents := jsonb_build_object();
            
            -- Extract localized content from notifications
            FOR i IN 0..jsonb_array_length(notification_group.notifications) - 1 LOOP
                localized_contents := jsonb_set(
                    localized_contents,
                    ARRAY[(notification_group.notifications->i->>'locale')],
                    to_jsonb(notification_group.notifications->i->>'content')
                );
            END LOOP;
            
            -- Ensure English content is always present for OneSignal
            IF NOT (localized_contents ? 'en') OR (localized_contents->>'en') IS NULL OR (localized_contents->>'en') = '' THEN
                -- Find the first available content and use it as English fallback
                DECLARE
                    first_key TEXT;
                    first_content TEXT;
                BEGIN
                    -- Get the first available locale key
                    SELECT jsonb_object_keys(localized_contents)->0 INTO first_key;
                    
                    -- Get the content for that locale
                    SELECT localized_contents->>first_key INTO first_content;
                    
                    -- Set it as English content
                    IF first_content IS NOT NULL AND first_content != '' THEN
                        localized_contents := jsonb_set(localized_contents, ARRAY['en'], to_jsonb(first_content));
                    END IF;
                END;
            END IF;
            
            -- Call OneSignal API via http_post with timeout
            one_signal_response := public.http_post(
                url := 'https://onesignal.com/api/v1/notifications',
                body := jsonb_build_object(
                    'app_id', current_setting('app.settings.onesignal_app_id', true),
                    'contents', localized_contents,
                    'headings', jsonb_build_object(
                        'en', (SELECT title FROM public.notifications WHERE id = notification_group.ids[1] AND locale = 'en')
                    ),
                    'url', COALESCE(notification_group.deep_link, 'timercoffee://app'),
                    'included_segments', jsonb_build_array('All'),
                    'isIos', notification_group.platform = 'ios' OR notification_group.platform = 'all',
                    'isAndroid', notification_group.platform = 'android' OR notification_group.platform = 'all',
                    'isWeb', notification_group.platform = 'web' OR notification_group.platform = 'all'
                ),
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'Authorization', 'Basic ' || current_setting('app.settings.onesignal_api_key', true)
                ),
                timeout_milliseconds := 10000  -- 10 second timeout
            );
            
            -- If OneSignal call was successful, mark notifications as sent
            IF one_signal_response LIKE '%id%' THEN
                UPDATE public.notifications
                SET is_sent = TRUE, sent_at = NOW()
                WHERE id = ANY(notification_group.ids);
                
                processed_count := processed_count + array_length(notification_group.ids, 1);
                
                -- Log successful send
                RAISE LOG 'Successfully sent notification group scheduled at % with % notifications', 
                    notification_group.scheduled_at, array_length(notification_group.ids, 1);
            ELSE
                -- Log failed send but don't fail the entire job
                RAISE LOG 'Failed to send notification group scheduled at %: %', 
                    notification_group.scheduled_at, substring(one_signal_response, 1, 500);
            END IF;
            
        EXCEPTION WHEN OTHERS THEN
            -- Log error but continue processing other groups
            RAISE LOG 'Error processing notification group: %', SQLERRM;
        END;
    END LOOP;
    
    -- Log job completion
    RAISE LOG 'Completed scheduled notifications processing. Processed % notifications in % seconds', 
        processed_count, EXTRACT(EPOCH FROM (NOW() - job_start_time));
END;
$$;

-- Update translate_notification_after_insert to always include English in translations
CREATE OR REPLACE FUNCTION public.translate_notification_after_insert()
RETURNS TRIGGER
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    project_url TEXT := (SELECT decrypted_secret FROM supabase_vault.decrypted_secrets WHERE name = 'supabase_url');
    edge_function_url TEXT;
    locales TEXT[];
    v_notification_group_id UUID;
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
    v_notification_group_id := COALESCE(NEW.notification_group_id, gen_random_uuid());
    
    -- Update the notification with the group ID
    UPDATE public.notifications 
    SET notification_group_id = v_notification_group_id 
    WHERE id = NEW.id;

    -- Gather target locales (exclude source locale, but always include English if not source)
    SELECT array_agg(locale) INTO locales
    FROM supported_locales
    WHERE locale <> NEW.locale
    OR (locale = 'en' AND NEW.locale <> 'en');  -- Always include English if not source

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
            'notification_group_id', v_notification_group_id::text
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

-- Add comment to document the fix
COMMENT ON FUNCTION public.process_and_send_scheduled_notifications() IS 'Enhanced to ensure English content is always present for OneSignal API compliance';
COMMENT ON FUNCTION public.translate_notification_after_insert() IS 'Enhanced to always include English in translation list if not source locale';