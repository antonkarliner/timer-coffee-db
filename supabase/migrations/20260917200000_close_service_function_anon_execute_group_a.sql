-- Plan 033 Group A. Supabase default privileges grant EXECUTE to the named roles
-- anon and authenticated, so revoke from public alone never removed those grants.
-- Reachability was confirmed by an anon probe returning HTTP 200 on 2026-09-16.
-- All located callers are edge functions using the service-role key, plus cron as
-- postgres; both are retained. The expected end state for every function listed
-- below is {postgres=X, service_role=X}.
--
-- Groups B-D (the remaining 12 SECURITY DEFINER and 7 invoker-rights service
-- functions) are deliberately not included in this migration and remain gated on
-- Plan 033 section 2's operator-approved classification.

revoke execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) from public;
revoke execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) from anon;
revoke execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) from authenticated;
grant execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) to service_role;
grant execute on function service.get_user_tokens_by_locale(p_user_id uuid, p_preferred_locale text) to postgres;

revoke execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) from public;
revoke execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) from anon;
revoke execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) from authenticated;
grant execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) to service_role;
grant execute on function service.log_delivery_results_secure(p_notification_id uuid, p_user_id uuid, p_token_id uuid, p_token text, p_device_type text, p_status text, p_error_code text, p_error_message text, p_fcm_message_id text) to postgres;

revoke execute on function service.delete_old_deleted_user_recipes() from public;
revoke execute on function service.delete_old_deleted_user_recipes() from anon;
revoke execute on function service.delete_old_deleted_user_recipes() from authenticated;
grant execute on function service.delete_old_deleted_user_recipes() to service_role;
grant execute on function service.delete_old_deleted_user_recipes() to postgres;

revoke execute on function service.cleanup_invalid_tokens(p_max_age_days integer) from public;
revoke execute on function service.cleanup_invalid_tokens(p_max_age_days integer) from anon;
revoke execute on function service.cleanup_invalid_tokens(p_max_age_days integer) from authenticated;
grant execute on function service.cleanup_invalid_tokens(p_max_age_days integer) to service_role;
grant execute on function service.cleanup_invalid_tokens(p_max_age_days integer) to postgres;

revoke execute on function service.lock_due_scheduled_notifications(p_limit integer) from public;
revoke execute on function service.lock_due_scheduled_notifications(p_limit integer) from anon;
revoke execute on function service.lock_due_scheduled_notifications(p_limit integer) from authenticated;
grant execute on function service.lock_due_scheduled_notifications(p_limit integer) to service_role;
grant execute on function service.lock_due_scheduled_notifications(p_limit integer) to postgres;

revoke execute on function service.lock_due_live_activity_events(p_limit integer) from public;
revoke execute on function service.lock_due_live_activity_events(p_limit integer) from anon;
revoke execute on function service.lock_due_live_activity_events(p_limit integer) from authenticated;
grant execute on function service.lock_due_live_activity_events(p_limit integer) to service_role;
grant execute on function service.lock_due_live_activity_events(p_limit integer) to postgres;

revoke execute on function service.lock_due_app_release_notifications(p_limit integer) from public;
revoke execute on function service.lock_due_app_release_notifications(p_limit integer) from anon;
revoke execute on function service.lock_due_app_release_notifications(p_limit integer) from authenticated;
grant execute on function service.lock_due_app_release_notifications(p_limit integer) to service_role;
grant execute on function service.lock_due_app_release_notifications(p_limit integer) to postgres;

revoke execute on function service.hash_fcm_token(token_input text) from public;
revoke execute on function service.hash_fcm_token(token_input text) from anon;
revoke execute on function service.hash_fcm_token(token_input text) from authenticated;
grant execute on function service.hash_fcm_token(token_input text) to service_role;
grant execute on function service.hash_fcm_token(token_input text) to postgres;
