-- Drop the legacy OneSignal notification pipeline.
--
-- History:
--   2025-10-01  public.notifications created; send-notification edge function
--               inserted rows; translate_notification_after_insert trigger fired
--               translate-and-send-notification which called OneSignal.
--   2025-11-09  FCM migration: service.notifications + service.user_fcm_tokens
--               created; process_scheduled_notifications_cron() re-pointed to
--               process-scheduled-notifications-fcm edge function.
--   2026-03-29  (this migration) Dead OneSignal objects removed.
--
-- Nothing active references public.notifications:
--   • Last row inserted: 2025-10-01 (38 test rows)
--   • service.notifications has 146 live rows and is the canonical table
--   • send-notification and translate-and-send-notification edge functions
--     have been replaced with 410 tombstones

-- 1. Remove the trigger that fired on every insert into public.notifications
DROP TRIGGER IF EXISTS translate_notification_after_insert ON public.notifications;

-- 2. Remove the updated_at bookkeeping trigger
DROP TRIGGER IF EXISTS handle_notifications_updated_at ON public.notifications;

-- 3. Drop the trigger function (OneSignal translation dispatcher)
DROP FUNCTION IF EXISTS public.translate_notification_after_insert();

-- 4. Drop the OneSignal send function (was never connected to an active cron job
--    after the FCM migration; process_scheduled_notifications_cron() already
--    points to process-scheduled-notifications-fcm)
DROP FUNCTION IF EXISTS public.process_and_send_scheduled_notifications();

-- 5. Drop the dead table (no FK references, no active writers)
DROP TABLE IF EXISTS public.notifications;
