-- Enable pg_cron extension if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Create a function that processes scheduled notifications and sends them via OneSignal
CREATE OR REPLACE FUNCTION public.process_and_send_scheduled_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    notification_group RECORD;
    localized_contents JSONB;
    notification_ids BIGINT[];
    one_signal_response TEXT;
BEGIN
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
    LOOP
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
        
        -- Call OneSignal API via http_post
        one_signal_response := net.http_post(
            url := 'https://onesignal.com/api/v1/notifications',
            body := jsonb_build_object(
                'app_id', current_setting('app.settings.onesignal_app_id', true),
                'contents', localized_contents,
                'url', COALESCE(notification_group.deep_link, 'timercoffee://app'),
                'included_segments', jsonb_build_array('All'),
                'isIos', notification_group.platform = 'ios' OR notification_group.platform = 'all',
                'isAndroid', notification_group.platform = 'android' OR notification_group.platform = 'all',
                'isWeb', notification_group.platform = 'web' OR notification_group.platform = 'all'
            ),
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Basic ' || current_setting('app.settings.onesignal_api_key', true)
            )
        );
        
        -- If OneSignal call was successful, mark notifications as sent
        IF one_signal_response LIKE '%id%' THEN
            UPDATE public.notifications
            SET is_sent = TRUE, sent_at = NOW()
            WHERE id = ANY(notification_group.ids);
            
            -- Log successful send
            RAISE LOG 'Successfully sent notification group scheduled at %', notification_group.scheduled_at;
        ELSE
            -- Log failed send
            RAISE LOG 'Failed to send notification group scheduled at %: %', notification_group.scheduled_at, one_signal_response;
        END IF;
    END LOOP;
END;
$$;

-- Schedule the cron job to run every minute
SELECT cron.schedule(
    'process-scheduled-notifications',
    '* * * * *',  -- Every minute
    'SELECT public.process_and_send_scheduled_notifications();'
);