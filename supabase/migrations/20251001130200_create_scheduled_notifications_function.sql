-- Function to process scheduled notifications
CREATE OR REPLACE FUNCTION public.process_scheduled_notifications()
RETURNS TABLE(notification_id BIGINT, status TEXT, locale TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    notification_record RECORD;
BEGIN
    -- Return notifications that are ready to be sent
    FOR notification_record IN 
        SELECT id, content, locale, platform, deep_link
        FROM public.notifications
        WHERE scheduled_at <= NOW()
        AND is_sent = FALSE
        AND is_translated = TRUE
        ORDER BY created_at
    LOOP
        -- Update notification as sent
        UPDATE public.notifications
        SET is_sent = TRUE, sent_at = NOW()
        WHERE id = notification_record.id;
        
        -- Return the processed notification
        notification_id := notification_record.id;
        status := 'sent';
        locale := notification_record.locale;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- Function to get scheduled notifications grouped by scheduled time
CREATE OR REPLACE FUNCTION public.get_grouped_scheduled_notifications()
RETURNS TABLE(
    scheduled_at TIMESTAMPTZ,
    notifications JSONB,
    platform TEXT,
    deep_link TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
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
        deep_link
    FROM public.notifications
    WHERE scheduled_at <= NOW()
    AND is_sent = FALSE
    AND is_translated = TRUE
    GROUP BY scheduled_at, platform, deep_link
    ORDER BY scheduled_at;
END;
$$;