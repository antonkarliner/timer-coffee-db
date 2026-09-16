-- Plan 033, Group B: revoke default-privilege EXECUTE from anon/authenticated on
-- the remaining SECURITY DEFINER functions in the `service` schema.
--
-- Same defect as Group A (20260916120000): Supabase's ALTER DEFAULT PRIVILEGES
-- grants EXECUTE on new `service` functions to anon, authenticated and
-- service_role, `service` is exposed through the Data API, and `revoke ... from
-- public` does not touch grants held by named roles.
--
-- Section 2's classification (recorded in plans/033) located every caller:
-- edge functions building their client with SUPABASE_SERVICE_ROLE_KEY, pg_cron
-- jobs running as postgres, or trigger bodies. All three keep EXECUTE below.
--
-- The three trigger-only functions here do not need caller EXECUTE at all: the
-- privilege is checked at CREATE TRIGGER time, not at fire time (measured, and
-- previously measured by plan 032 in `public`). They are revoked anyway so the
-- ACLs stop advertising a grant nothing uses.
--
-- None of these appears in an RLS policy qual, a column default or a check
-- constraint — verified against pg_policies and pg_attrdef before writing this.
-- service.is_admin() does appear in 22 policy quals and is handled separately;
-- see plan 033 Group D.

-- service.aggregate_notification_analytics — service_role (edge fn aggregate-notification-analytics) + postgres (cron
-- aggregate-notification-analytics via public.aggregate_notification_analytics_cron)
revoke execute on function service.aggregate_notification_analytics(p_date date, p_hour integer) from public;
revoke execute on function service.aggregate_notification_analytics(p_date date, p_hour integer) from anon;
revoke execute on function service.aggregate_notification_analytics(p_date date, p_hour integer) from authenticated;
grant  execute on function service.aggregate_notification_analytics(p_date date, p_hour integer) to service_role;
grant  execute on function service.aggregate_notification_analytics(p_date date, p_hour integer) to postgres;

-- service.enqueue_live_activity_events — service_role (edge fn live-activity-api)
revoke execute on function service.enqueue_live_activity_events(p_session_id uuid, p_watchdog_interval_seconds integer) from public;
revoke execute on function service.enqueue_live_activity_events(p_session_id uuid, p_watchdog_interval_seconds integer) from anon;
revoke execute on function service.enqueue_live_activity_events(p_session_id uuid, p_watchdog_interval_seconds integer) from authenticated;
grant  execute on function service.enqueue_live_activity_events(p_session_id uuid, p_watchdog_interval_seconds integer) to service_role;
grant  execute on function service.enqueue_live_activity_events(p_session_id uuid, p_watchdog_interval_seconds integer) to postgres;

-- service.ensure_user_notification_preferences — service_role (edge fn notification-api)
revoke execute on function service.ensure_user_notification_preferences(p_user_id uuid) from public;
revoke execute on function service.ensure_user_notification_preferences(p_user_id uuid) from anon;
revoke execute on function service.ensure_user_notification_preferences(p_user_id uuid) from authenticated;
grant  execute on function service.ensure_user_notification_preferences(p_user_id uuid) to service_role;
grant  execute on function service.ensure_user_notification_preferences(p_user_id uuid) to postgres;

-- service.finalize_live_activity_event — service_role (edge fn process-live-activity-events-fcm)
revoke execute on function service.finalize_live_activity_event(p_event_id uuid, p_status text, p_error text) from public;
revoke execute on function service.finalize_live_activity_event(p_event_id uuid, p_status text, p_error text) from anon;
revoke execute on function service.finalize_live_activity_event(p_event_id uuid, p_status text, p_error text) from authenticated;
grant  execute on function service.finalize_live_activity_event(p_event_id uuid, p_status text, p_error text) to service_role;
grant  execute on function service.finalize_live_activity_event(p_event_id uuid, p_status text, p_error text) to postgres;

-- service.get_broadcast_target_locales — service_role (edge fn notification-api)
revoke execute on function service.get_broadcast_target_locales(p_target_device_types text[], p_target_user_ids uuid[]) from public;
revoke execute on function service.get_broadcast_target_locales(p_target_device_types text[], p_target_user_ids uuid[]) from anon;
revoke execute on function service.get_broadcast_target_locales(p_target_device_types text[], p_target_user_ids uuid[]) from authenticated;
grant  execute on function service.get_broadcast_target_locales(p_target_device_types text[], p_target_user_ids uuid[]) to service_role;
grant  execute on function service.get_broadcast_target_locales(p_target_device_types text[], p_target_user_ids uuid[]) to postgres;

-- service.get_user_target_locales — service_role (edge fn send-fcm-notification)
revoke execute on function service.get_user_target_locales(p_user_id uuid, p_target_device_types text[]) from public;
revoke execute on function service.get_user_target_locales(p_user_id uuid, p_target_device_types text[]) from anon;
revoke execute on function service.get_user_target_locales(p_user_id uuid, p_target_device_types text[]) from authenticated;
grant  execute on function service.get_user_target_locales(p_user_id uuid, p_target_device_types text[]) to service_role;
grant  execute on function service.get_user_target_locales(p_user_id uuid, p_target_device_types text[]) to postgres;

-- service.cancel_orphan_events_on_session_end — internal — trigger service.live_activity_sessions.trg_cancel_orphan_events_on_session_end
revoke execute on function service.cancel_orphan_events_on_session_end() from public;
revoke execute on function service.cancel_orphan_events_on_session_end() from anon;
revoke execute on function service.cancel_orphan_events_on_session_end() from authenticated;
grant  execute on function service.cancel_orphan_events_on_session_end() to service_role;
grant  execute on function service.cancel_orphan_events_on_session_end() to postgres;

-- service.notify_roaster_candidates — internal — trigger service.new_roaster_candidates.notify_roaster_candidates_trigger
revoke execute on function service.notify_roaster_candidates() from public;
revoke execute on function service.notify_roaster_candidates() from anon;
revoke execute on function service.notify_roaster_candidates() from authenticated;
grant  execute on function service.notify_roaster_candidates() to service_role;
grant  execute on function service.notify_roaster_candidates() to postgres;

-- service.sync_roaster_processed — internal — trigger service.new_roaster_candidates.sync_roaster_processed_trigger
revoke execute on function service.sync_roaster_processed() from public;
revoke execute on function service.sync_roaster_processed() from anon;
revoke execute on function service.sync_roaster_processed() from authenticated;
grant  execute on function service.sync_roaster_processed() to service_role;
grant  execute on function service.sync_roaster_processed() to postgres;

-- service.get_cron_job_status — no caller located in any of the four repos, no cron, no policy, no trigger;
-- operator approved the revoke on 2026-09-16
revoke execute on function service.get_cron_job_status(p_job_id text, p_limit integer, p_offset integer) from public;
revoke execute on function service.get_cron_job_status(p_job_id text, p_limit integer, p_offset integer) from anon;
revoke execute on function service.get_cron_job_status(p_job_id text, p_limit integer, p_offset integer) from authenticated;
grant  execute on function service.get_cron_job_status(p_job_id text, p_limit integer, p_offset integer) to service_role;
grant  execute on function service.get_cron_job_status(p_job_id text, p_limit integer, p_offset integer) to postgres;

-- service.update_template_stats — no caller located in any of the four repos, no cron, no policy, no trigger;
-- operator approved the revoke on 2026-09-16
revoke execute on function service.update_template_stats(p_template_id uuid, p_success boolean) from public;
revoke execute on function service.update_template_stats(p_template_id uuid, p_success boolean) from anon;
revoke execute on function service.update_template_stats(p_template_id uuid, p_success boolean) from authenticated;
grant  execute on function service.update_template_stats(p_template_id uuid, p_success boolean) to service_role;
grant  execute on function service.update_template_stats(p_template_id uuid, p_success boolean) to postgres;
