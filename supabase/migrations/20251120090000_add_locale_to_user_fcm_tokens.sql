-- Add locale column to user_fcm_tokens table for FCM localization support
-- This enables per-device language targeting for notifications

-- Add locale column with sensible default
ALTER TABLE service.user_fcm_tokens 
ADD COLUMN locale TEXT DEFAULT 'en';

-- Create index for efficient locale-based queries
CREATE INDEX idx_service_user_fcm_tokens_locale ON service.user_fcm_tokens(locale);

-- Create composite index for user+locale queries (common for targeted notifications)
CREATE INDEX idx_service_user_fcm_tokens_user_locale ON service.user_fcm_tokens(user_id, locale);

-- Add comment to document the new column
COMMENT ON COLUMN service.user_fcm_tokens.locale IS 'Device locale code (ISO 639-1) for notification language targeting. Defaults to "en" for English.';

-- Add constraint to ensure valid locale codes (basic validation)
ALTER TABLE service.user_fcm_tokens 
ADD CONSTRAINT valid_locale 
CHECK (
  locale IN ('en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'sv', 'da', 'no', 'fi', 'pl', 'cs', 'sk', 'hu', 'ro', 'bg', 'hr', 'sl', 'et', 'lv', 'lt', 'mt', 'ga', 'cy', 'eu', 'ca', 'gl', 'is', 'mk', 'sq', 'sr', 'bs', 'me', 'hr', 'sl', 'tr', 'ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'mn', 'ko', 'ja', 'zh', 'th', 'vi', 'ms', 'id', 'tl', 'hi', 'bn', 'ta', 'te', 'ml', 'kn', 'gu', 'mr', 'ne', 'si', 'my', 'km', 'lo', 'ka', 'am', 'sw', 'zu', 'af', 'is', 'mt', 'cy', 'ga', 'gd', 'eu', 'ca') OR locale IS NULL
);

-- Update existing tokens to have a default locale if they're NULL
UPDATE service.user_fcm_tokens 
SET locale = 'en' 
WHERE locale IS NULL;

-- Create a function to get tokens by user and preferred locale
CREATE OR REPLACE FUNCTION service.get_user_tokens_by_locale(
    p_user_id UUID,
    p_preferred_locale TEXT DEFAULT 'en'
)
RETURNS TABLE (
    id UUID,
    token TEXT,
    device_type TEXT,
    locale TEXT,
    is_active BOOLEAN,
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        t.id,
        t.token,
        t.device_type,
        t.locale,
        t.is_active,
        t.created_at,
        t.updated_at
    FROM service.user_fcm_tokens t
    WHERE t.user_id = p_user_id
      AND t.is_active = true
    ORDER BY 
        CASE 
            WHEN t.locale = p_preferred_locale THEN 1
            WHEN t.locale = 'en' THEN 2  -- English as fallback
            ELSE 3
        END,
        t.created_at DESC;  -- Most recent first within same locale
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add comment for the new function
COMMENT ON FUNCTION service.get_user_tokens_by_locale(UUID, TEXT) IS 'Returns user FCM tokens ordered by preferred locale, with English as fallback. Useful for localized notification targeting.';

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION service.get_user_tokens_by_locale(UUID, TEXT) TO authenticated;
