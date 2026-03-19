-- Migration: Make user_id nullable in service.notifications
-- This allows broadcast notifications to have user_id = NULL

-- 1. Make user_id nullable
ALTER TABLE service.notifications 
ALTER COLUMN user_id DROP NOT NULL;

-- 2. Update RLS policy (users only see their targeted notifications)
DROP POLICY IF EXISTS "Users view own notifications" ON service.notifications;
CREATE POLICY "Users view own notifications" ON service.notifications
    FOR SELECT USING (auth.uid() = user_id);

-- 3. Add policy for admins to view broadcast notifications
DROP POLICY IF EXISTS "Admin view all notifications" ON service.notifications;
CREATE POLICY "Admin view all notifications" ON service.notifications
    FOR SELECT USING (public.is_admin());

-- 4. Add index for broadcast notification queries
CREATE INDEX IF NOT EXISTS idx_service_notifications_user_id_null 
ON service.notifications(user_id) WHERE user_id IS NULL;

-- 5. Add comment
COMMENT ON COLUMN service.notifications.user_id IS 
'User ID for targeted notifications. NULL for broadcast notifications.';

-- 6. Add index for efficient user notification queries
CREATE INDEX IF NOT EXISTS idx_service_notifications_user_id_created_at 
ON service.notifications(user_id, created_at DESC) WHERE user_id IS NOT NULL;