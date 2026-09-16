-- Plan 033, Group A: revoke default-privilege EXECUTE from anon/authenticated on
-- the highest-value `service` schema functions.
--
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on every newly created
-- function in `service` to anon, authenticated and service_role. Those are grants
-- to *named* roles, so the `revoke ... from public` idiom this repo used before
-- 2026-09-16 left them in place. The `service` schema is exposed through the Data
-- API (supabase/config.toml), so PostgREST serves /rest/v1/rpc/<fn> for anything
-- in it that the caller's role may execute.
--
-- Confirmed reachable on 2026-09-16: an anonymous caller holding only the
-- publishable key got HTTP 200 from service.get_user_tokens_by_locale, a
-- SECURITY DEFINER function that returns raw FCM tokens for an arbitrary user id.
--
-- Every located caller of these eight functions is an edge function using the
-- service-role key, or pg_cron running as postgres; both keep EXECUTE below.
-- Nested calls from other SECURITY DEFINER functions run as the owner, also
-- retained. service.is_admin() is deliberately NOT in this group: 22 RLS policies
-- call it, and an RLS qual is evaluated as the querying role, so revoking it turns
-- anon/authenticated reads into 42501 errors. It is handled separately.

-- service.get_user_tokens_by_locale — returns raw FCM tokens
revoke execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) from public;
revoke execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) from anon;
revoke execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) from authenticated;
grant  execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) to service_role;
grant  execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) to postgres;

-- service.log_delivery_results_secure — accepts a raw token, writes delivery logs
revoke execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) from public;
revoke execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) from anon;
revoke execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) from authenticated;
grant  execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) to service_role;
grant  execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) to postgres;

-- service.delete_old_deleted_user_recipes — destructive, no arguments; cron job
-- `delete-old-user-recipes` runs it as postgres
revoke execute on function service.delete_old_deleted_user_recipes() from public;
revoke execute on function service.delete_old_deleted_user_recipes() from anon;
revoke execute on function service.delete_old_deleted_user_recipes() from authenticated;
grant  execute on function service.delete_old_deleted_user_recipes() to service_role;
grant  execute on function service.delete_old_deleted_user_recipes() to postgres;

-- service.cleanup_invalid_tokens — destructive; attacker-chosen age could purge live tokens
revoke execute on function service.cleanup_invalid_tokens(p_max_age_days integer) from public;
revoke execute on function service.cleanup_invalid_tokens(p_max_age_days integer) from anon;
revoke execute on function service.cleanup_invalid_tokens(p_max_age_days integer) from authenticated;
grant  execute on function service.cleanup_invalid_tokens(p_max_age_days integer) to service_role;
grant  execute on function service.cleanup_invalid_tokens(p_max_age_days integer) to postgres;

-- service.lock_due_scheduled_notifications — claims worker rows (denial-of-delivery)
revoke execute on function service.lock_due_scheduled_notifications(p_limit integer) from public;
revoke execute on function service.lock_due_scheduled_notifications(p_limit integer) from anon;
revoke execute on function service.lock_due_scheduled_notifications(p_limit integer) from authenticated;
grant  execute on function service.lock_due_scheduled_notifications(p_limit integer) to service_role;
grant  execute on function service.lock_due_scheduled_notifications(p_limit integer) to postgres;

-- service.lock_due_live_activity_events — claims worker rows; returns fcm_token and
-- activity_push_token columns
revoke execute on function service.lock_due_live_activity_events(p_limit integer) from public;
revoke execute on function service.lock_due_live_activity_events(p_limit integer) from anon;
revoke execute on function service.lock_due_live_activity_events(p_limit integer) from authenticated;
grant  execute on function service.lock_due_live_activity_events(p_limit integer) to service_role;
grant  execute on function service.lock_due_live_activity_events(p_limit integer) to postgres;

-- service.lock_due_app_release_notifications — claims worker rows
revoke execute on function service.lock_due_app_release_notifications(p_limit integer) from public;
revoke execute on function service.lock_due_app_release_notifications(p_limit integer) from anon;
revoke execute on function service.lock_due_app_release_notifications(p_limit integer) from authenticated;
grant  execute on function service.lock_due_app_release_notifications(p_limit integer) to service_role;
grant  execute on function service.lock_due_app_release_notifications(p_limit integer) to postgres;

-- service.hash_fcm_token — hashing oracle over attacker-supplied input; only
-- in-database caller is service.log_delivery_results_secure (SECURITY DEFINER,
-- so it executes as the owner)
revoke execute on function service.hash_fcm_token(token_input text) from public;
revoke execute on function service.hash_fcm_token(token_input text) from anon;
revoke execute on function service.hash_fcm_token(token_input text) from authenticated;
grant  execute on function service.hash_fcm_token(token_input text) to service_role;
grant  execute on function service.hash_fcm_token(token_input text) to postgres;
