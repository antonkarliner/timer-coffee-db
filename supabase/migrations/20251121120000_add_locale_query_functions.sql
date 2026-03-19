-- Add functions to query distinct locales from user_fcm_tokens
-- These functions support the new locale-based notification system

-- Function: Get distinct locales for broadcast notifications
-- Returns all distinct locales from active tokens, optionally filtered by device types
CREATE OR REPLACE FUNCTION service.get_broadcast_target_locales(
    p_target_device_types TEXT[] DEFAULT NULL,
    p_target_user_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
    locale TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT t.locale
    FROM service.user_fcm_tokens t
    WHERE t.is_active = true
      AND (p_target_device_types IS NULL OR t.device_type = ANY(p_target_device_types))
      AND (p_target_user_ids IS NULL OR t.user_id = ANY(p_target_user_ids))
    ORDER BY t.locale;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Comment for the broadcast locales function
COMMENT ON FUNCTION service.get_broadcast_target_locales(TEXT[], UUID[]) IS 
'Returns distinct locales from active FCM tokens for broadcast notifications. 
Filters by device types and user IDs if provided. Used to derive target_locales 
from the source locale parameter.';

-- Function: Get distinct locales for a specific user
-- Returns all distinct locales from a user's active tokens
CREATE OR REPLACE FUNCTION service.get_user_target_locales(
    p_user_id UUID,
    p_target_device_types TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    locale TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT DISTINCT t.locale
    FROM service.user_fcm_tokens t
    WHERE t.user_id = p_user_id
      AND t.is_active = true
      AND (p_target_device_types IS NULL OR t.device_type = ANY(p_target_device_types))
    ORDER BY t.locale;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Comment for the user locales function
COMMENT ON FUNCTION service.get_user_target_locales(UUID, TEXT[]) IS 
'Returns distinct locales from a user''s active FCM tokens. 
Filters by device types if provided. Used to derive target_locales 
from the source locale parameter for individual user notifications.';

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION service.get_broadcast_target_locales(TEXT[], UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION service.get_user_target_locales(UUID, TEXT[]) TO authenticated;

-- Create indexes to optimize locale queries (if not already created by previous migration)
CREATE INDEX IF NOT EXISTS idx_service_user_fcm_tokens_active_locale 
ON service.user_fcm_tokens(is_active, locale) 
WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_service_user_fcm_tokens_user_active_locale 
ON service.user_fcm_tokens(user_id, is_active, locale) 
WHERE is_active = true;