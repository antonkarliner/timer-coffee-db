-- Drop unused notification token IP column.
-- The production app stores FCM tokens directly without populating this field,
-- and the notification API no longer writes it.

ALTER TABLE service.user_fcm_tokens
DROP COLUMN IF EXISTS ip_address;
