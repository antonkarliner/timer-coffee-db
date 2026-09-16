-- Plan 033, Group C: revoke default-privilege EXECUTE from anon/authenticated on
-- the 7 invoker-rights functions in the `service` schema.
--
-- Lowest tier of the same defect Groups A (20260916120000) and B (20260916130000)
-- closed: these run as the caller, so RLS and table grants still constrain them.
-- They are revoked anyway because `service` is exposed through the Data API and
-- there is no caller that needs the grant.
--
-- Four of the seven are trigger bodies. Firing a trigger does not consult the
-- querying role's EXECUTE privilege — that is checked at CREATE TRIGGER time —
-- so revoking these does not affect any INSERT or UPDATE performed by anon or
-- authenticated. Measured twice: plan 032 in `public`, and again here against the
-- real `service` triggers on user_fcm_tokens, feature_flags and
-- new_roaster_candidates before this migration was written.
--
-- The three cron functions run as `postgres`, which keeps EXECUTE below.
-- normalize_roaster_name is reached only through SECURITY DEFINER callers, so it
-- executes as the owner; the app path public.roaster_contribution_target was
-- exercised as `authenticated` with this revoke applied and still worked.
--
-- None of the seven appears in an RLS policy qual, a column default or a check
-- constraint — verified against pg_policies and pg_attrdef.

-- service.aggregate_performance_metrics — postgres — cron job aggregate-performance-metrics, username postgres
revoke execute on function service.aggregate_performance_metrics() from public;
revoke execute on function service.aggregate_performance_metrics() from anon;
revoke execute on function service.aggregate_performance_metrics() from authenticated;
grant  execute on function service.aggregate_performance_metrics() to service_role;
grant  execute on function service.aggregate_performance_metrics() to postgres;

-- service.check_alert_thresholds — postgres — cron job check-alert-thresholds, username postgres
revoke execute on function service.check_alert_thresholds() from public;
revoke execute on function service.check_alert_thresholds() from anon;
revoke execute on function service.check_alert_thresholds() from authenticated;
grant  execute on function service.check_alert_thresholds() to service_role;
grant  execute on function service.check_alert_thresholds() to postgres;

-- service.cleanup_old_logs — postgres — cron job cleanup-old-logs, username postgres
revoke execute on function service.cleanup_old_logs() from public;
revoke execute on function service.cleanup_old_logs() from anon;
revoke execute on function service.cleanup_old_logs() from authenticated;
grant  execute on function service.cleanup_old_logs() to service_role;
grant  execute on function service.cleanup_old_logs() to postgres;

-- service.assign_roaster_candidate_cluster — internal — trigger service.new_roaster_candidates.assign_roaster_candidate_cluster_trigger
revoke execute on function service.assign_roaster_candidate_cluster() from public;
revoke execute on function service.assign_roaster_candidate_cluster() from anon;
revoke execute on function service.assign_roaster_candidate_cluster() from authenticated;
grant  execute on function service.assign_roaster_candidate_cluster() to service_role;
grant  execute on function service.assign_roaster_candidate_cluster() to postgres;

-- service.set_updated_at — internal — 9 triggers across service (app_release_notifications, feature_flags,
-- notification_analytics, notification_templates, notifications, roaster_postprocess_jobs,
-- scheduled_notifications, user_fcm_tokens, user_notification_preferences)
revoke execute on function service.set_updated_at() from public;
revoke execute on function service.set_updated_at() from anon;
revoke execute on function service.set_updated_at() from authenticated;
grant  execute on function service.set_updated_at() to service_role;
grant  execute on function service.set_updated_at() to postgres;

-- service.update_updated_at_column — internal — 7 triggers across service (alert_thresholds, health_checks,
-- live_activity_events, live_activity_sessions, performance_metrics, system_logs, usage_analytics)
revoke execute on function service.update_updated_at_column() from public;
revoke execute on function service.update_updated_at_column() from anon;
revoke execute on function service.update_updated_at_column() from authenticated;
grant  execute on function service.update_updated_at_column() to service_role;
grant  execute on function service.update_updated_at_column() to postgres;

-- service.normalize_roaster_name — internal — called only from public.roaster_contribution_target,
-- service.assign_roaster_candidate_cluster and service.resolve_roaster_for_cluster, all of
-- which are SECURITY DEFINER or trigger bodies, so the nested call runs as the owner
revoke execute on function service.normalize_roaster_name(input text) from public;
revoke execute on function service.normalize_roaster_name(input text) from anon;
revoke execute on function service.normalize_roaster_name(input text) from authenticated;
grant  execute on function service.normalize_roaster_name(input text) to service_role;
grant  execute on function service.normalize_roaster_name(input text) to postgres;
